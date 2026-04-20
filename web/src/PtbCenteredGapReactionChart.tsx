import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import { pickBookLevels, midPrice } from './bookLevels';
import { anchorPriceScale, buildSpotCandles, type SpotCandle } from './spotVsPtb';

const BUCKET_N = 22;
const ANCHOR_FRAC = 0.44;
const BIN_COUNT = 48;
const GAP_STRONG = 0.36;
const PATH_GAP = 0.4;
function sideThresholdUsd(level: number): number {
  return Math.max(1.5, Math.abs(level) * 2.5e-5);
}

type Bin = { lo: number; hi: number; tickMass: number; bookMass: number };

function emptyBins(plotMin: number, plotMax: number, n: number): Bin[] {
  const w = (plotMax - plotMin) / n;
  return Array.from({ length: n }, (_, i) => ({
    lo: plotMin + i * w,
    hi: plotMin + (i + 1) * w,
    tickMass: 0,
    bookMass: 0,
  }));
}

function binIndexUsd(v: number, plotMin: number, plotMax: number, n: number): number {
  const w = (plotMax - plotMin) / n;
  return Math.max(0, Math.min(n - 1, Math.floor((v - plotMin) / w + 1e-12)));
}

function addBookMassUsd(
  bins: Bin[],
  bids: { price: number; size: number }[],
  asks: { price: number; size: number }[],
  mid: number | null,
  spotLast: number,
  spanUsd: number,
  plotMin: number,
  plotMax: number,
): void {
  if (mid == null || !Number.isFinite(mid)) return;
  const levels = [...bids.slice(0, 28), ...asks.slice(0, 28)];
  if (levels.length === 0) return;
  const spread = Math.max(...levels.map((l) => l.price)) - Math.min(...levels.map((l) => l.price));
  const scale = spanUsd / Math.max(0.06, Math.min(0.45, spread + 0.02));
  const n = bins.length;
  for (const l of levels) {
    if (!Number.isFinite(l.price) || !Number.isFinite(l.size) || l.size <= 0) continue;
    const usd = spotLast + (l.price - mid) * scale;
    const mass = Math.sqrt(l.size) * (0.35 + l.price);
    bins[binIndexUsd(usd, plotMin, plotMax, n)]!.bookMass += mass;
  }
}

function normalize01(vals: number[]): number[] {
  const m = Math.max(1e-9, ...vals);
  return vals.map((v) => Math.min(1, v / m));
}

function contiguousMaxMean(scores: number[], i0: number, i1: number): { mean: number; a: number; b: number } | null {
  const lo = Math.min(i0, i1);
  const hi = Math.max(i0, i1);
  if (lo > hi) return null;
  let bestMean = -1;
  let bestA = lo;
  let bestB = lo;
  for (let a = lo; a <= hi; a++) {
    let s = 0;
    for (let b = a; b <= hi; b++) {
      s += scores[b]!;
      const len = b - a + 1;
      const mean = s / len;
      if (mean > bestMean && len >= 2) {
        bestMean = mean;
        bestA = a;
        bestB = b;
      }
    }
  }
  return bestMean < 0 ? null : { mean: bestMean, a: bestA, b: bestB };
}

function touchEps(level: number): number {
  return Math.max(0.35, Math.abs(level) * 1.5e-6);
}

type PtbCandleTag = 'breakUp' | 'breakDown' | 'rejectAbove' | 'rejectBelow' | 'touch' | 'none';

function classifyCandleUsd(c: SpotCandle, level: number): PtbCandleTag {
  const e = touchEps(level);
  const { o, h, l, c: cl } = c;
  const spans = l <= level && h >= level;
  if (o < level - e && cl > level + e) return 'breakUp';
  if (o > level + e && cl < level - e) return 'breakDown';
  if (spans && h > level + e && cl < level - e) return 'rejectAbove';
  if (spans && l < level - e && cl > level + e) return 'rejectBelow';
  if (spans) return 'touch';
  return 'none';
}

function fmtUsd(x: number): string {
  return `$${x.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtUsdSigned(x: number): string {
  const s = x >= 0 ? '+' : '';
  return `${s}$${Math.abs(x).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtAxisPrice(p: number): string {
  const a = Math.abs(p);
  if (a >= 1_000_000) return `$${(p / 1_000_000).toFixed(2)}M`;
  if (a >= 1000) return `$${(p / 1000).toFixed(2)}k`;
  return `$${p.toFixed(2)}`;
}

function toPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  let d = `M ${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i]!.x.toFixed(2)} ${points[i]!.y.toFixed(2)}`;
  return d;
}

/**
 * Polymarket-style PTB chart: USD OHLC / line, dashed yellow PTB, right price axis,
 * gap heat in price space, path-of-least-resistance toward PTB when vacuum aligns.
 */
export function PtbCenteredGapReactionChart(props: {
  spot: SpotPoint[];
  priceToBeat: number | null;
  lastUpdateMs: number | null;
  bookAbove: unknown;
  bookBelow: unknown;
  /** e.g. "BTC Price (USD)" */
  chartTitle?: string;
  aboveLabel?: string;
  belowLabel?: string;
}): ReactElement | null {
  const { spot, priceToBeat, lastUpdateMs, bookAbove, bookBelow, chartTitle = 'Spot (USD)', aboveLabel = 'Above', belowLabel = 'Below' } = props;
  const [mode, setMode] = useState<'ohlc' | 'line'>('ohlc');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 2000);
    return () => window.clearInterval(id);
  }, []);
  const pts = useMemo(() => spot.slice(-320), [spot]);
  const level = priceToBeat;

  const candles = useMemo(() => {
    if (level == null || pts.length < 2) return [];
    return buildSpotCandles(pts, BUCKET_N);
  }, [level, pts]);

  const model = useMemo(() => {
    if (level == null || pts.length < 2) return null;
    const vals = pts.map((p) => p.v);
    const spotMin = Math.min(...vals);
    const spotMax = Math.max(...vals);
    const { plotMin, plotMax } = anchorPriceScale({
      level,
      spotMin,
      spotMax,
      anchorFrac: ANCHOR_FRAC,
    });
    const span = Math.max(1e-9, plotMax - plotMin);
    const sessionRange = Math.max(1e-6, spotMax - spotMin, Math.abs(vals[vals.length - 1]! - level) * 0.5);
    const last = vals[vals.length - 1]!;

    const bins = emptyBins(plotMin, plotMax, BIN_COUNT);
    for (const p of pts) {
      bins[binIndexUsd(p.v, plotMin, plotMax, BIN_COUNT)]!.tickMass += 1;
    }
    const { bids: bA, asks: aA } = pickBookLevels(bookAbove);
    const { bids: bB, asks: aB } = pickBookLevels(bookBelow);
    addBookMassUsd(bins, bA, aA, midPrice(bookAbove), last, sessionRange, plotMin, plotMax);
    addBookMassUsd(bins, bB, aB, midPrice(bookBelow), last, sessionRange, plotMin, plotMax);

    const tickN = normalize01(bins.map((b) => b.tickMass));
    const bookN = normalize01(bins.map((b) => b.bookMass));
    const tickVac = tickN.map((t) => 1 - t);
    const bookVac = bookN.map((t) => 1 - t);
    const composite = bins.map((_, i) => Math.max(tickVac[i]! * 0.62 + bookVac[i]! * 0.38, tickVac[i]! * 0.85));

    const iSpot = binIndexUsd(last, plotMin, plotMax, BIN_COUNT);
    const iPtb = binIndexUsd(level, plotMin, plotMax, BIN_COUNT);
    const sideE = sideThresholdUsd(level);
    const toward = contiguousMaxMean(composite, iSpot, iPtb);
    const gapAbovePath = last < level - sideE && toward != null && toward.mean >= PATH_GAP;
    const gapBelowPath = last > level + sideE && toward != null && toward.mean >= PATH_GAP;

    const first = vals[0]!;
    const chg = last - first;
    const pct = Math.abs(first) > 1e-12 ? (chg / first) * 100 : 0;

    return {
      plotMin,
      plotMax,
      span,
      last,
      first,
      chg,
      pct,
      bins,
      composite,
      gapAbovePath,
      gapBelowPath,
      sideE,
      level,
      tMin: pts[0]!.t,
      tMax: pts[pts.length - 1]!.t,
    };
  }, [level, pts, bookAbove, bookBelow]);

  if (level == null || pts.length < 2 || !model) {
    return (
      <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/35 p-4 text-sm text-zinc-500 ring-1 ring-white/[0.02]">
        Load SSR PTB, RTDS spot, and books for this chart.
      </div>
    );
  }

  const { plotMin, plotMax, span, last, first, chg, pct, bins, composite, gapAbovePath, gapBelowPath, sideE, tMin, tMax } = model;

  const width = 680;
  const height = 276;
  const padL = 14;
  const padR = 58;
  const padY = 14;
  const innerH = height - padY * 2;
  const innerW = width - padL - padR;
  const tSpan = Math.max(1, tMax - tMin);

  const yPrice = (v: number) => padY + (1 - (v - plotMin) / span) * innerH;
  const xTime = (t: number) => padL + ((t - tMin) / tSpan) * innerW;

  const yBeat = yPrice(level);
  const yLast = yPrice(last);
  const yTop = padY;
  const yBot = padY + innerH;

  const stale = lastUpdateMs == null || now - lastUpdateMs > 12_000;

  const xy = pts.map((p) => ({ x: xTime(p.t), y: yPrice(p.v) }));
  const lineFillPath =
    xy.length > 0
      ? `${toPath(xy)} L ${xy[xy.length - 1]!.x.toFixed(2)} ${yBot.toFixed(2)} L ${xy[0]!.x.toFixed(2)} ${yBot.toFixed(2)} Z`
      : '';

  const yTicks = 5;
  const tickPrices = Array.from({ length: yTicks }, (_, i) => plotMin + ((plotMax - plotMin) * i) / (yTicks - 1));

  const xTickTs = [tMin, tMin + tSpan * 0.33, tMin + tSpan * 0.66, tMax];
  const hi = Math.max(1e-9, ...composite);
  const gapShade = (g: number) => 0.05 + 0.38 * Math.pow(g / hi, 0.9);

  const above = last > level + sideE;
  const below = last < level - sideE;

  const pillW = Math.min(168, innerW * 0.28);
  const pillX = width - padR - pillW - 6;
  const pillY = Math.min(Math.max(padY + 4, yBeat - 20), height - 36);

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-800/80 bg-[#0c0c0e] shadow-xl ring-1 ring-zinc-700/40">
      {/* Header — reference: title, big price, change, toggles, LIVE */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-800/80 px-4 py-3">
        <div>
          <div className="text-[12px] font-medium tracking-wide text-zinc-400">{chartTitle}</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-2">
            <span className="text-[22px] font-semibold tabular-nums tracking-tight text-zinc-50">{fmtUsd(last)}</span>
            <span className={`text-[13px] font-semibold tabular-nums ${chg >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {fmtUsdSigned(chg)} ({chg >= 0 ? '+' : ''}
              {pct.toFixed(1)}%)
            </span>
          </div>
          <div className="mt-1 font-mono text-[10px] text-zinc-600">
            vs window open {fmtUsd(first)} · PTB {fmtUsd(level)}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-zinc-700/80 bg-zinc-900/80 p-0.5">
            <button
              type="button"
              onClick={() => setMode('line')}
              className={`rounded-md px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
                mode === 'line' ? 'bg-zinc-700 text-emerald-300' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Line
            </button>
            <button
              type="button"
              onClick={() => setMode('ohlc')}
              className={`rounded-md px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
                mode === 'ohlc' ? 'bg-emerald-900/50 text-emerald-300' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              OHLC
            </button>
          </div>
          <div
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${
              stale ? 'border-zinc-700 bg-zinc-900 text-zinc-500' : 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300'
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${stale ? 'bg-zinc-600' : 'animate-pulse bg-emerald-400'}`} />
            Live
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/60 px-4 py-2">
        <div
          className={`rounded-lg border px-3 py-1.5 font-mono text-[11px] ${
            above ? 'border-emerald-800/50 bg-emerald-950/30 text-emerald-200' : below ? 'border-rose-800/50 bg-rose-950/30 text-rose-200' : 'border-amber-800/40 bg-amber-950/25 text-amber-100'
          }`}
        >
          {above ? 'ABOVE PTB' : below ? 'BELOW PTB' : 'AT PTB'} · {fmtUsdSigned(last - level)} from PTB
        </div>
        {gapAbovePath ? (
          <span className="text-[11px] text-emerald-400/90">Path: vacuum up toward PTB</span>
        ) : gapBelowPath ? (
          <span className="text-[11px] text-rose-400/90">Path: vacuum down toward PTB</span>
        ) : (
          <span className="text-[11px] text-zinc-600">Path overlay idle</span>
        )}
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="block w-full bg-[#0a0a0c]" style={{ maxHeight: 300 }}>
        <defs>
          <linearGradient id="ptbRefItm" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(34 197 94)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="rgb(34 197 94)" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="ptbRefBelow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(244 63 94)" stopOpacity="0.02" />
            <stop offset="100%" stopColor="rgb(244 63 94)" stopOpacity="0.12" />
          </linearGradient>
          <linearGradient id="ptbRefLineFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(52 211 153)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="rgb(52 211 153)" stopOpacity="0.03" />
          </linearGradient>
          <linearGradient id="pathUpUsd" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity="0.04" />
          </linearGradient>
          <linearGradient id="pathDownUsd" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(244 63 94)" stopOpacity="0.04" />
            <stop offset="100%" stopColor="rgb(244 63 94)" stopOpacity="0.35" />
          </linearGradient>
        </defs>

        <rect x="0" y="0" width={width} height={height} fill="#0a0a0c" />

        {/* Low-resistance (gap) — price space */}
        {bins.map((b, i) => {
          const y1 = yPrice(b.hi);
          const y2 = yPrice(b.lo);
          const top = Math.min(y1, y2);
          const h = Math.max(1.2, Math.abs(y2 - y1));
          const g = composite[i] ?? 0;
          if (g < GAP_STRONG * hi) return null;
          return (
            <rect
              key={`g-${i}`}
              x={padL}
              y={top}
              width={innerW}
              height={h}
              fill={`rgba(139, 92, 246, ${gapShade(g)})`}
              className="pointer-events-none"
            />
          );
        })}

        {/* Reference-style: tint above last print toward top when above PTB */}
        {last > level ? (
          <rect x={padL} y={yTop} width={innerW} height={Math.max(0, yLast - yTop)} fill="url(#ptbRefItm)" className="pointer-events-none" />
        ) : last < level ? (
          <rect x={padL} y={yLast} width={innerW} height={Math.max(0, yBot - yLast)} fill="url(#ptbRefBelow)" className="pointer-events-none" />
        ) : null}

        {gapAbovePath && last < level ? (
          <rect
            x={padL}
            y={yBeat}
            width={innerW}
            height={Math.max(2, yLast - yBeat)}
            fill="url(#pathUpUsd)"
            className="pointer-events-none"
          />
        ) : null}
        {gapBelowPath && last > level ? (
          <rect
            x={padL}
            y={yLast}
            width={innerW}
            height={Math.max(2, yBeat - yLast)}
            fill="url(#pathDownUsd)"
            className="pointer-events-none"
          />
        ) : null}

        {mode === 'line' && xy.length > 1 ? (
          <path d={lineFillPath} fill="url(#ptbRefLineFill)" className="pointer-events-none" />
        ) : null}
        {mode === 'line' && xy.length > 1 ? (
          <path d={toPath(xy)} fill="none" stroke="rgb(52 211 153)" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
        ) : null}

        {mode === 'ohlc'
          ? candles.map((c, i) => {
              const tag = classifyCandleUsd(c, level);
              const bull = c.c >= c.o;
              let stroke = bull ? 'rgb(52 211 153)' : 'rgb(248 113 113)';
              let fill = bull ? 'rgba(34,197,94,0.55)' : 'rgba(248,113,113,0.5)';
              if (tag === 'touch' || tag.startsWith('reject')) {
                stroke = 'rgb(250 204 21)';
                fill = tag.includes('reject') ? 'rgba(250,204,21,0.35)' : 'rgba(250,204,21,0.22)';
              } else if (tag.startsWith('break')) {
                stroke = bull ? 'rgb(74 222 128)' : 'rgb(252 165 165)';
                fill = bull ? 'rgba(74,222,128,0.65)' : 'rgba(252,165,165,0.55)';
              }
              const x0 = xTime(c.t0);
              const x1 = xTime(c.t1);
              const xc = (x0 + x1) / 2;
              const bw = Math.max(3.2, (x1 - x0) * 0.55);
              const yH = yPrice(c.h);
              const yL = yPrice(c.l);
              const yO = yPrice(c.o);
              const yC = yPrice(c.c);
              const top = Math.min(yO, yC);
              const bot = Math.max(yO, yC);
              const bodyH = Math.max(1.4, bot - top);
              return (
                <g key={`c-${c.t0}-${i}`}>
                  <line x1={xc} x2={xc} y1={yH} y2={yL} stroke={stroke} strokeWidth={1.15} opacity={0.95} />
                  <rect x={xc - bw / 2} y={top} width={bw} height={bodyH} rx={1} fill={fill} stroke={stroke} strokeWidth={1.05} />
                </g>
              );
            })
          : null}

        {/* PTB: dashed yellow + soft underlay so it never disappears on candles */}
        <line
          x1={padL}
          x2={padL + innerW}
          y1={yBeat}
          y2={yBeat}
          stroke="rgb(234 179 8)"
          strokeWidth={8}
          strokeLinecap="round"
          opacity={0.2}
        />
        <line
          x1={padL}
          x2={padL + innerW}
          y1={yBeat}
          y2={yBeat}
          stroke="rgb(250 204 21)"
          strokeWidth={2.5}
          strokeDasharray="7 5"
          strokeLinecap="round"
        />
        <text
          x={padL + 4}
          y={Math.max(padY + 12, Math.min(yBeat - 6, pillY - 2))}
          fill="rgb(250 204 21)"
          fontSize="12"
          fontWeight="700"
          fontFamily="ui-sans-serif, system-ui, sans-serif"
        >
          Price to Beat
        </text>
        <rect x={pillX} y={pillY} width={pillW} height={22} rx={11} fill="rgb(234 179 8)" fillOpacity={0.95} />
        <text
          x={pillX + pillW / 2}
          y={pillY + 16}
          textAnchor="middle"
          fill="#0a0a0a"
          fontSize="11"
          fontWeight="800"
          fontFamily="ui-monospace, monospace"
        >
          PTB {fmtUsd(level)}
        </text>

        <circle cx={xTime(tMax)} cy={yLast} r={6} fill="white" stroke="rgb(234 179 8)" strokeWidth={2.5} />

        {/* Y-axis (right) */}
        {tickPrices.map((tp, i) => (
          <text
            key={`yt-${i}`}
            x={width - padR + 6}
            y={yPrice(tp) + 4}
            fill="rgb(161 161 170)"
            fontSize="10"
            fontFamily="ui-monospace, monospace"
          >
            {fmtAxisPrice(tp)}
          </text>
        ))}

        {/* X-axis */}
        {xTickTs.map((ts, i) => (
          <text
            key={`xt-${i}`}
            x={xTime(ts)}
            y={height - 4}
            textAnchor="middle"
            fill="rgb(113 113 122)"
            fontSize="9"
            fontFamily="ui-monospace, monospace"
          >
            {new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </text>
        ))}

        <text x={padL + 4} y={height - padY - 2} fill="rgb(82 82 91)" fontSize="9" fontFamily="ui-monospace, monospace">
          Gap heat (violet) · {aboveLabel}/{belowLabel} · not financial advice
        </text>
      </svg>
    </div>
  );
}
