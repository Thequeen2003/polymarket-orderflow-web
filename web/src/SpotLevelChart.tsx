import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { spotVsLevelSentence } from './chartReadouts';
import { describeSpot } from './liveContext';
import type { BookSnapshot } from './orderflowMetrics';
import { STREAM_ATTRIBUTION_LINE } from './streamAttribution';
import { analyzePtbReaction, buildSpotCandles, candleStraddlesPtb } from './spotVsPtb';

export type SpotPoint = { t: number; v: number };

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function extent(vals: number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of vals) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) return { min: min - 1, max: max + 1 };
  return { min, max };
}

function toPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  let d = `M ${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i]!.x.toFixed(2)} ${points[i]!.y.toFixed(2)}`;
  return d;
}

function fmtUsd(x: number): string {
  return `$${x.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtUsdSigned(x: number): string {
  const s = x >= 0 ? '+' : '';
  return `${s}${fmtUsd(x)}`;
}

const BUCKET_N = 20;

function kindLabel(k: string): string {
  const m: Record<string, string> = {
    approaching_touch: 'Approaching',
    touching: 'Touching',
    holding_at_line: 'Holding',
    choppy_at_line: 'Choppy',
    rejecting_off_line: 'Rejection',
    break_probe: 'Probe',
    break_hold: 'Break + hold',
    extension_confirming: 'Extension',
    drifting_no_interaction: 'Drifting',
  };
  return m[k] ?? k;
}

function tierBadgeClass(tier: string): string {
  if (tier === 'strong') return 'border-emerald-600/45 bg-emerald-950/35 text-emerald-100';
  if (tier === 'hesitant') return 'border-amber-600/45 bg-amber-950/35 text-amber-100';
  if (tier === 'rejection') return 'border-rose-600/45 bg-rose-950/35 text-rose-100';
  return 'border-zinc-600/45 bg-zinc-900/50 text-zinc-300';
}

function shapeLabel(shape: string): string {
  const m: Record<string, string> = {
    clean_push: 'Clean push',
    hesitation: 'Hesitation',
    rejection: 'Rejection',
    unclear: 'Unclear',
  };
  return m[shape] ?? shape;
}

function extFtLabel(ft: string): string {
  if (ft === 'follow_through') return 'FTH';
  if (ft === 'stall') return 'STALL';
  if (ft === 'mixed') return 'MIXED';
  return '—';
}

export function SpotLevelChart({
  title,
  spot,
  priceToBeat,
  lastUpdateMs,
  bookFlow,
  bookFlowAtMs,
}: {
  title: string;
  spot: SpotPoint[];
  priceToBeat: number | null;
  lastUpdateMs: number | null;
  bookFlow?: BookSnapshot[];
  bookFlowAtMs?: number | null;
}): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  const stale = lastUpdateMs == null ? true : now - lastUpdateMs > 10_000;
  const flowStale = bookFlowAtMs == null ? true : now - bookFlowAtMs > 20_000;

  const width = 580;
  const height = 248;
  const pad = 14;
  const innerH = height - pad * 2;
  const innerW = width - pad * 2;

  const pts = useMemo(() => spot.slice(-280), [spot]);
  const tMin = pts.length ? Math.min(...pts.map((p) => p.t)) : 0;
  const tMax = pts.length ? Math.max(...pts.map((p) => p.t)) : 1;
  const tSpan = Math.max(1, tMax - tMin);

  const vals = pts.map((p) => p.v);
  const spotMin = vals.length ? Math.min(...vals) : 0;
  const spotMax = vals.length ? Math.max(...vals) : 1;

  const candles = useMemo(() => buildSpotCandles(pts, BUCKET_N), [pts]);

  const reaction = useMemo(() => {
    if (priceToBeat == null || pts.length < 2) return null;
    return analyzePtbReaction({ pts, candles, level: priceToBeat, bookFlow });
  }, [bookFlow, candles, priceToBeat, pts]);

  const scale = useMemo(() => {
    if (priceToBeat != null && pts.length >= 2) {
      const needAbove = Math.max(0, spotMax - priceToBeat);
      const needBelow = Math.max(0, priceToBeat - spotMin);
      const halfSpan = Math.max(needAbove, needBelow, Math.abs(priceToBeat) * 3e-5, 1);
      return { plotMin: priceToBeat - halfSpan * 1.08, plotMax: priceToBeat + halfSpan * 1.08 };
    }
    const allVals = priceToBeat != null ? [...vals, priceToBeat] : vals;
    const { min, max } = extent(allVals.length ? allVals : [0, 1]);
    return { plotMin: min, plotMax: max };
  }, [priceToBeat, pts, spotMax, spotMin, vals]);

  const yPrice = (v: number) => {
    const r = scale.plotMax - scale.plotMin;
    const den = r > 1e-12 ? r : 1;
    return pad + (1 - clamp01((v - scale.plotMin) / den)) * innerH;
  };
  const xTime = (t: number) => pad + ((t - tMin) / tSpan) * innerW;

  const xy = pts.map((p) => ({ x: xTime(p.t), y: yPrice(p.v) }));
  const last = pts[pts.length - 1]?.v ?? null;
  const absDist = last != null && priceToBeat != null ? Math.abs(last - priceToBeat) : null;
  const ctx = useMemo(() => describeSpot({ spot, priceToBeat }), [priceToBeat, spot]);

  const yBeat = priceToBeat != null ? yPrice(priceToBeat) : null;
  const ptbPillText = priceToBeat != null ? `PTB ${fmtUsd(priceToBeat)}` : '';
  const ptbPillH = 22;
  const ptbPillW = priceToBeat != null ? Math.min(172, Math.max(92, 14 + ptbPillText.length * 6.4)) : 0;
  const ptbPillX = width - pad - ptbPillW - 6;
  const ptbPillY =
    yBeat != null
      ? Math.max(pad + 4, Math.min(yBeat - ptbPillH / 2, height - pad - ptbPillH - 4))
      : 0;

  const maxExtAbove =
    priceToBeat != null && vals.length ? Math.max(0, spotMax - priceToBeat) : 0;
  const maxProbeBelow =
    priceToBeat != null && vals.length ? Math.max(0, priceToBeat - spotMin) : 0;

  const ySessionLow = yPrice(spotMin);
  const ySessionHigh = yPrice(spotMax);

  const eps = reaction?.eps ?? 0;
  const bandY0 = priceToBeat != null ? yPrice(priceToBeat + eps) : null;
  const bandY1 = priceToBeat != null ? yPrice(priceToBeat - eps) : null;

  const yTicks = useMemo(() => {
    const out: { y: number; v: number; label: string }[] = [];
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = scale.plotMax - ((scale.plotMax - scale.plotMin) * i) / steps;
      out.push({ y: yPrice(v), v, label: fmtUsd(v) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale.plotMax, scale.plotMin]);

  const xTicks = useMemo(() => {
    if (pts.length < 2) return [];
    const steps = 4;
    const out: { x: number; t: number; label: string }[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = tMin + (tSpan * i) / steps;
      out.push({ x: xTime(t), t, label: new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tMin, tSpan, pts.length]);

  const nowSide = useMemo(() => {
    if (last == null || priceToBeat == null) return null as null | { side: 'ABOVE' | 'BELOW' | 'AT'; dist: number };
    const d = last - priceToBeat;
    const e = reaction?.eps ?? Math.max(0.5, priceToBeat * 8e-5);
    if (Math.abs(d) <= e) return { side: 'AT', dist: d };
    return { side: d > 0 ? 'ABOVE' : 'BELOW', dist: d };
  }, [last, priceToBeat, reaction?.eps]);

  return (
    <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/35 p-4 shadow-inner shadow-black/15 ring-1 ring-white/[0.02]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[15px] font-semibold tracking-wide text-zinc-200">{title}</div>
        <div className="flex flex-wrap gap-2">
          <div
            className={`rounded-full border px-3 py-1.5 text-[13px] font-semibold uppercase tracking-wide ${
              stale ? 'border-zinc-700/40 bg-zinc-950/40 text-zinc-500' : 'border-emerald-700/40 bg-emerald-950/25 text-emerald-200'
            }`}
            title={lastUpdateMs ? `Last RTDS tick ${new Date(lastUpdateMs).toLocaleTimeString()}` : 'No ticks yet'}
          >
            spot {stale ? 'stale' : 'live'}
          </div>
          {bookFlow != null && bookFlow.length > 0 ? (
            <div
              className={`rounded-full border px-3 py-1.5 text-[13px] font-semibold uppercase tracking-wide ${
                flowStale ? 'border-zinc-700/40 bg-zinc-950/40 text-zinc-500' : 'border-sky-700/40 bg-sky-950/25 text-sky-200'
              }`}
              title="Book snapshots aligned to PTB-touch buckets (~5s poll)"
            >
              book {flowStale ? 'stale' : 'live'}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-2 text-[13px] text-zinc-300">
        <div className="rounded-md bg-zinc-900/50 px-2.5 py-1.5 font-mono">spot {last != null ? fmtUsd(last) : '—'}</div>
        <div className="rounded-md border border-amber-800/40 bg-amber-950/25 px-2.5 py-1.5 font-mono text-amber-100/90">
          PTB {priceToBeat != null ? fmtUsd(priceToBeat) : '—'}
        </div>
        <div
          className={`rounded-md border px-2.5 py-1.5 font-mono ${
            nowSide?.side === 'ABOVE'
              ? 'border-emerald-800/40 bg-emerald-950/20 text-emerald-100'
              : nowSide?.side === 'BELOW'
                ? 'border-rose-800/40 bg-rose-950/20 text-rose-100'
                : nowSide?.side === 'AT'
                  ? 'border-amber-800/40 bg-amber-950/20 text-amber-100'
                  : 'border-zinc-800/50 bg-zinc-900/40 text-zinc-300'
          }`}
          title="Direction is determined by last spot vs PTB (inside band = AT)"
        >
          now {nowSide ? `${nowSide.side} ${fmtUsdSigned(nowSide.dist)}` : '—'}
        </div>
        <div
          className="rounded-md bg-zinc-900/50 px-2.5 py-1.5 font-mono"
          title="Absolute distance — direction matters less than how price meets the line"
        >
          |vs PTB| {absDist != null ? fmtUsd(absDist) : '—'}
        </div>
        {reaction ? (
          <div
            className="rounded-md border border-zinc-600/50 bg-zinc-900/60 px-2.5 py-1.5 font-mono text-zinc-200"
            title="Half-width of the interaction band around PTB"
          >
            band ±{reaction.eps.toFixed(2)}
          </div>
        ) : null}
        {reaction ? (
          <div
            className="rounded-md border border-violet-800/35 bg-violet-950/25 px-2.5 py-1.5 font-mono text-violet-100/90"
            title="Follow-through vs stall after PTB contact"
          >
            ext {extFtLabel(reaction.extensionFollowThrough)}
          </div>
        ) : null}
        {reaction && reaction.orderFlowAggressive != null ? (
          <div
            className={`rounded-md border px-2 py-1 font-mono text-[10px] font-semibold ${
              reaction.orderFlowAggressive
                ? 'border-sky-600/40 bg-sky-950/30 text-sky-100'
                : 'border-zinc-600/40 bg-zinc-900/50 text-zinc-400'
            }`}
            title="CLOB mids + churn while PTB-touch buckets were active"
          >
            CLOB @PTB {reaction.orderFlowAggressive ? 'active' : 'drift'}
          </div>
        ) : null}
        <div className="rounded-md border border-emerald-900/30 bg-emerald-950/15 px-2 py-1 font-mono text-emerald-200/90" title="Max extension above PTB (wing)">
          wing +{maxExtAbove > 0 ? maxExtAbove.toFixed(2) : '—'}
        </div>
        <div className="rounded-md border border-rose-900/30 bg-rose-950/15 px-2 py-1 font-mono text-rose-200/90" title="Max extension below PTB (wing)">
          wing −{maxProbeBelow > 0 ? maxProbeBelow.toFixed(2) : '—'}
        </div>
      </div>

      {reaction ? (
        <div className="mt-3 rounded-2xl border-2 border-teal-800/40 bg-gradient-to-b from-teal-950/35 via-zinc-950/50 to-zinc-950/70 px-4 py-3 shadow-inner shadow-black/20 ring-1 ring-teal-900/25">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-extrabold uppercase tracking-wide text-teal-200/95">Reaction strength</span>
            <span className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">primary</span>
            <span className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase ${tierBadgeClass(reaction.reactionStrength.tier)}`}>
              {reaction.reactionStrength.tier}
            </span>
            <span className="rounded-md border border-zinc-600/50 bg-black/35 px-2 py-0.5 text-[10px] font-semibold text-zinc-200">
              {shapeLabel(reaction.reactionStrength.shape)}
            </span>
            {reaction.reactionStrength.avgBodyAtPtbPct != null ? (
              <span className="font-mono text-[10px] text-zinc-500">body@PTB {reaction.reactionStrength.avgBodyAtPtbPct}%</span>
            ) : null}
            {reaction.reactionStrength.wickyBucketPct != null ? (
              <span className="font-mono text-[10px] text-zinc-500">wicky {reaction.reactionStrength.wickyBucketPct}%</span>
            ) : null}
          </div>
          <p className="mt-2.5 text-[13px] font-medium leading-snug text-zinc-50">{reaction.reactionStrength.primary}</p>
          <p className="mt-2 text-[11px] leading-snug text-amber-100/85">{reaction.headline}</p>

          {priceToBeat != null && last != null ? (() => {
            const eps = reaction.eps;
            const dist = last - priceToBeat;
            const absDist = Math.abs(dist);
            const inBand = absDist <= eps * 1.05;
            const side = dist >= 0 ? 'UP' : 'DOWN';
            const tier = reaction.reactionStrength.tier;
            const kind = reaction.kind;
            const isChop = kind === 'choppy_at_line' || tier === 'weak';
            const isRejection = tier === 'rejection' || kind === 'rejecting_off_line';
            const isConfirm = kind === 'break_hold' || kind === 'extension_confirming' || tier === 'strong';
            const verdict =
              inBand || isChop ? 'WAIT' : isRejection ? 'FADE / WAIT' : isConfirm ? `ENTER ${side}` : `LEAN ${side}`;
            const tone =
              verdict.startsWith('ENTER UP')
                ? 'border-emerald-700/45 bg-emerald-950/20 text-emerald-100'
                : verdict.startsWith('ENTER DOWN')
                  ? 'border-rose-700/45 bg-rose-950/20 text-rose-100'
                  : verdict.startsWith('LEAN UP')
                    ? 'border-emerald-800/35 bg-black/20 text-emerald-200/90'
                    : verdict.startsWith('LEAN DOWN')
                      ? 'border-rose-800/35 bg-black/20 text-rose-200/90'
                      : verdict.startsWith('FADE')
                        ? 'border-amber-700/45 bg-amber-950/15 text-amber-100'
                        : 'border-zinc-700/60 bg-zinc-950/25 text-zinc-200';
            const why =
              inBand
                ? `Inside band (±$${eps.toFixed(2)}) — wait for a clean break + hold.`
                : isChop
                  ? 'Chop / weak reaction — do not force entries at the line.'
                  : isRejection
                    ? 'Rejection at PTB — continuation is less trustworthy right now.'
                    : isConfirm
                      ? `Confirmed separation ${dist >= 0 ? 'above' : 'below'} PTB — trade the break side until reclaim.`
                      : `Outside band ${dist >= 0 ? 'above' : 'below'} PTB — bias exists but needs more confirmation.`;
            return (
              <div className="mt-2 rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Best side right now</div>
                  <div className={`rounded-lg border px-2 py-1 text-[11px] font-black ${tone}`}>{verdict}</div>
                </div>
                <div className="mt-1 text-[11px] leading-snug text-zinc-300">{why}</div>
              </div>
            );
          })() : null}

          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
            <span className="rounded border border-zinc-700/50 bg-zinc-900/60 px-1.5 py-0.5 font-mono">{kindLabel(reaction.kind)}</span>
            <span>{reaction.candleAtPtb}</span>
          </div>
        </div>
      ) : null}

      <svg viewBox={`0 0 ${width} ${height}`} className="mt-3 h-[320px] w-full">
        <defs>
          <linearGradient id="spotChartBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(9 9 11)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="rgb(0 0 0)" stopOpacity="0.35" />
          </linearGradient>
          <linearGradient id="spotExtAbove" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity="0.14" />
            <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="spotVoidBelow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(244 63 94)" stopOpacity="0.06" />
            <stop offset="100%" stopColor="rgb(244 63 94)" stopOpacity="0.14" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width={width} height={height} rx="14" fill="url(#spotChartBg)" className="stroke-zinc-800/50" />

        {/* Plot frame */}
        <rect x={pad} y={pad} width={innerW} height={innerH} rx="12" className="fill-transparent stroke-zinc-800/35" />

        {/* Gridlines + y-axis labels */}
        {yTicks.map((t, i) => (
          <g key={`gy-${i}`} className="pointer-events-none">
            <line x1={pad} x2={pad + innerW} y1={t.y} y2={t.y} className="stroke-zinc-800/30" strokeWidth={1} />
            <text x={width - pad - 6} y={t.y - 3} textAnchor="end" className="fill-zinc-500" fontSize="10" fontFamily="ui-monospace, monospace">
              {t.label}
            </text>
          </g>
        ))}

        {/* Vertical gridlines + x-axis labels */}
        {xTicks.map((t, i) => (
          <g key={`gx-${i}`} className="pointer-events-none">
            <line x1={t.x} x2={t.x} y1={pad} y2={pad + innerH} className="stroke-zinc-800/20" strokeWidth={1} />
            <text x={t.x} y={height - pad + 14} textAnchor="middle" className="fill-zinc-600" fontSize="10" fontFamily="ui-monospace, monospace">
              {t.label}
            </text>
          </g>
        ))}

        {reaction?.shellMarkAbove ? (
          <rect
            x={pad}
            y={yPrice(reaction.shellMarkAbove.hi)}
            width={innerW}
            height={Math.max(1, yPrice(reaction.shellMarkAbove.lo) - yPrice(reaction.shellMarkAbove.hi))}
            fill="rgb(139 92 246 / 0.09)"
            className="pointer-events-none"
          />
        ) : null}
        {reaction?.shellMarkBelow ? (
          <rect
            x={pad}
            y={yPrice(reaction.shellMarkBelow.hi)}
            width={innerW}
            height={Math.max(1, yPrice(reaction.shellMarkBelow.lo) - yPrice(reaction.shellMarkBelow.hi))}
            fill="rgb(139 92 246 / 0.09)"
            className="pointer-events-none"
          />
        ) : null}

        {priceToBeat != null && pts.length >= 2 ? (
          <>
            {yBeat != null && spotMax > priceToBeat ? (
              <rect
                x={pad}
                y={ySessionHigh}
                width={innerW}
                height={Math.max(0, yBeat - ySessionHigh)}
                fill="url(#spotExtAbove)"
                className="pointer-events-none"
              />
            ) : null}
            {yBeat != null && spotMin < priceToBeat ? (
              <rect
                x={pad}
                y={yBeat}
                width={innerW}
                height={Math.max(0, ySessionLow - yBeat)}
                fill="url(#spotVoidBelow)"
                className="pointer-events-none"
              />
            ) : null}
          </>
        ) : null}

        {/* Watermark labels to prevent above/below confusion (screen-space above = higher price). */}
        {yBeat != null && priceToBeat != null ? (
          <>
            <text
              x={pad + 10}
              y={Math.max(pad + 18, yBeat - 10)}
              fill="rgba(16,185,129,0.16)"
              fontSize="18"
              fontWeight={900}
              fontFamily="ui-sans-serif, system-ui, sans-serif"
              className="pointer-events-none select-none"
            >
              ABOVE PTB
            </text>
            <text
              x={pad + 10}
              y={Math.min(height - pad - 8, yBeat + 26)}
              fill="rgba(244,63,94,0.16)"
              fontSize="18"
              fontWeight={900}
              fontFamily="ui-sans-serif, system-ui, sans-serif"
              className="pointer-events-none select-none"
            >
              BELOW PTB
            </text>
          </>
        ) : null}

        {priceToBeat != null && pts.length >= 2 && bandY0 != null && bandY1 != null ? (
          <rect
            x={pad}
            y={Math.min(bandY0, bandY1)}
            width={innerW}
            height={Math.max(2, Math.abs(bandY1 - bandY0))}
            className="fill-amber-400/[0.10] stroke-amber-300/25"
            strokeWidth={1.25}
          />
        ) : null}

        {candles.map((c, i) => {
          const x0 = xTime(c.t0);
          const x1 = xTime(c.t1);
          const xc = (x0 + x1) / 2;
          const bw = Math.max(12, (x1 - x0) * 0.78);
          const yH = yPrice(c.h);
          const yL = yPrice(c.l);
          const yO = yPrice(c.o);
          const yC = yPrice(c.c);
          const top = Math.min(yO, yC);
          const bot = Math.max(yO, yC);
          const bodyH = Math.max(3, bot - top);
          const level = priceToBeat ?? null;
          const atPtb = level != null && eps > 0 && candleStraddlesPtb(c, level, eps);
          const wicky = c.bodyFrac < 0.22;
          const aboveBand = level != null && eps > 0 ? c.l > level + eps : level != null ? c.c > level : false;
          const belowBand = level != null && eps > 0 ? c.h < level - eps : level != null ? c.c < level : false;
          let stroke = 'rgb(161 161 170)';
          let fill = 'rgba(161,161,170,0.22)';
          if (atPtb) {
            stroke = wicky ? 'rgb(253 224 71 / 0.75)' : 'rgb(250 204 21 / 0.95)';
            fill = wicky ? 'rgba(250,204,21,0.14)' : 'rgba(250,204,21,0.32)';
          } else if (aboveBand) {
            // Position vs PTB is the primary encoding (prevents “green candle below PTB” confusion).
            stroke = wicky ? 'rgb(52 211 153 / 0.55)' : 'rgb(52 211 153 / 0.95)';
            fill = wicky ? 'rgba(16,185,129,0.12)' : 'rgba(16,185,129,0.34)';
          } else if (belowBand) {
            stroke = wicky ? 'rgb(251 113 133 / 0.55)' : 'rgb(251 113 133 / 0.95)';
            fill = wicky ? 'rgba(244,63,94,0.12)' : 'rgba(244,63,94,0.32)';
          } else {
            // Inside the band but not straddling: keep it neutral so “AT PTB” reads cleanly.
            stroke = 'rgb(161 161 170 / 0.75)';
            fill = 'rgba(161,161,170,0.18)';
          }
          const wickColor = atPtb ? 'rgb(250 204 21)' : stroke;
          return (
            <g key={`${c.t0}-${i}`}>
              <line x1={xc} x2={xc} y1={yH} y2={top} stroke={wickColor} strokeWidth={2.0} strokeLinecap="round" />
              <line x1={xc} x2={xc} y1={top + bodyH} y2={yL} stroke={wickColor} strokeWidth={2.0} strokeLinecap="round" />
              <rect
                x={xc - bw / 2}
                y={top}
                width={bw}
                height={bodyH}
                fill={fill}
                stroke={stroke}
                strokeWidth={1.25}
                rx={2.5}
              />
            </g>
          );
        })}

        {xy.length > 1 ? (
          <path d={toPath(xy)} className="stroke-indigo-100/45 fill-none" strokeWidth={1.8} strokeDasharray="5 4" />
        ) : null}
        {xy.length > 0 ? (
          <>
            <circle cx={xy[xy.length - 1]!.x} cy={xy[xy.length - 1]!.y} r="6.2" className="fill-indigo-200/25" />
            <circle cx={xy[xy.length - 1]!.x} cy={xy[xy.length - 1]!.y} r="3.9" className="fill-indigo-100" />
          </>
        ) : null}

        {reaction?.shellMarkAbove ? (
          <line
            x1={pad}
            x2={width - pad}
            y1={yPrice((reaction.shellMarkAbove.lo + reaction.shellMarkAbove.hi) / 2)}
            y2={yPrice((reaction.shellMarkAbove.lo + reaction.shellMarkAbove.hi) / 2)}
            stroke="rgb(196 181 253 / 0.45)"
            strokeWidth={1}
            strokeDasharray="3 4"
          />
        ) : null}
        {reaction?.shellMarkBelow ? (
          <line
            x1={pad}
            x2={width - pad}
            y1={yPrice((reaction.shellMarkBelow.lo + reaction.shellMarkBelow.hi) / 2)}
            y2={yPrice((reaction.shellMarkBelow.lo + reaction.shellMarkBelow.hi) / 2)}
            stroke="rgb(196 181 253 / 0.4)"
            strokeWidth={1}
            strokeDasharray="3 4"
          />
        ) : null}

        {/* (min/max labels are now drawn on the y-axis grid) */}

        {yBeat != null && priceToBeat != null ? (
          <g className="pointer-events-none" aria-label="Price to beat">
            {/* Soft track so the dashed PTB line stays visible on busy candles */}
            <line
              x1={pad}
              x2={width - pad}
              y1={yBeat}
              y2={yBeat}
              stroke="rgb(250 204 21)"
              strokeWidth={7}
              strokeLinecap="round"
              opacity={0.18}
            />
            <line
              x1={pad}
              x2={width - pad}
              y1={yBeat}
              y2={yBeat}
              stroke="rgb(250 204 21)"
              strokeWidth={1.6}
              strokeDasharray="6 5"
              strokeLinecap="round"
            />
            <text
              x={pad + 4}
              y={Math.max(pad + 12, Math.min(yBeat - 5, height - pad - 28))}
              fill="rgb(250 204 21)"
              fontSize="11"
              fontWeight={700}
              fontFamily="ui-sans-serif, system-ui, sans-serif"
            >
              Price to Beat
            </text>
            <rect x={ptbPillX} y={ptbPillY} width={ptbPillW} height={ptbPillH} rx={11} fill="rgb(250 204 21)" fillOpacity={0.96} />
            <text
              x={ptbPillX + ptbPillW / 2}
              y={ptbPillY + 15.5}
              textAnchor="middle"
              fill="#0a0a0a"
              fontSize="10.5"
              fontWeight={800}
              fontFamily="ui-monospace, monospace"
            >
              {ptbPillText}
            </text>
          </g>
        ) : null}

        {/* Last price label */}
        {last != null && Number.isFinite(last) ? (
          <g className="pointer-events-none" aria-label="Last spot price">
            <rect x={pad + 6} y={Math.max(pad + 6, Math.min(yPrice(last) - 11, height - pad - 26))} width="112" height="22" rx="11" fill="rgba(24,24,27,0.75)" stroke="rgba(161,161,170,0.35)" />
            <text
              x={pad + 12}
              y={Math.max(pad + 21, Math.min(yPrice(last) + 4.5, height - pad - 11))}
              fill="rgb(228 228 231)"
              fontSize="11"
              fontWeight={700}
              fontFamily="ui-monospace, monospace"
            >
              spot {fmtUsd(last)}
            </text>
          </g>
        ) : null}
      </svg>

      <div className="mt-2 flex flex-wrap gap-3 text-[10px] leading-snug text-zinc-500">
        <span>
          <span className="text-amber-300/90">▮</span> amber band + <span className="text-amber-200/80">yellow</span> candles = overlap with PTB
        </span>
        <span>
          <span className="text-emerald-400/80">▮</span>/<span className="text-rose-400/80">▮</span> candle color = position vs PTB (above/below)
        </span>
        <span>
          <span className="text-violet-300/80">▮</span> violet tint + dash = thinnest tick shell (gap / fast-move risk)
        </span>
        <span>
          <span className="text-emerald-400/80">▮</span>/<span className="text-rose-400/80">▮</span> wings = max extension away from PTB in-window
        </span>
      </div>

      <div className="mt-2 rounded-xl border border-zinc-800/40 bg-black/20 px-3 py-2 text-[11px] leading-relaxed text-zinc-400">
        <span className="font-semibold text-zinc-300">Live context:</span> {ctx.read || '—'}
      </div>

      {last != null && priceToBeat != null ? (
        <div className="mt-2 rounded-xl border border-zinc-800/50 bg-zinc-900/30 px-3 py-2 text-[11px] leading-relaxed text-zinc-300">
          <span className="font-semibold text-zinc-200">Resolution framing (above/below copy):</span>{' '}
          {spotVsLevelSentence(last, priceToBeat)}
        </div>
      ) : null}

      {reaction ? (
        <div className="mt-3 space-y-2 text-[11px] leading-relaxed text-zinc-300">
          <div className="rounded-xl border border-zinc-800/50 bg-zinc-950/50 px-3 py-2">
            <span className="font-semibold text-zinc-100">Interaction vs PTB</span>
            <p className="mt-1 text-zinc-400">{reaction.interaction}</p>
          </div>
          <div className="rounded-xl border border-sky-900/35 bg-sky-950/20 px-3 py-2">
            <span className="font-semibold text-sky-100">Order flow at PTB</span>
            <p className="mt-1 text-sky-100/75">{reaction.flowAtLine}</p>
          </div>
          <div className="rounded-xl border border-emerald-900/25 bg-emerald-950/15 px-3 py-2">
            <span className="font-semibold text-emerald-100">Extension after interaction</span>
            <p className="mt-1 text-emerald-100/75">{reaction.extensionAfterPtb}</p>
          </div>
          <div className="rounded-xl border border-violet-900/35 bg-violet-950/20 px-3 py-2">
            <span className="font-semibold text-violet-100">Liquidity / gaps around PTB</span>
            <p className="mt-1 text-violet-100/80">{reaction.gaps}</p>
          </div>
          <div className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 px-3 py-2.5">
            <p className="text-[11px] font-semibold text-zinc-200">Is the reaction at PTB strong enough to trust and trade?</p>
            <p className="mt-2 font-medium leading-snug text-zinc-100">{reaction.tradeAnswer}</p>
          </div>
        </div>
      ) : null}

      <details className="mt-2 rounded-xl border border-zinc-800/40 bg-zinc-900/25 px-3 py-2 text-[11px] text-zinc-400">
        <summary className="cursor-pointer font-semibold text-zinc-300">Visual priority and logic</summary>
        <ul className="mt-2 list-inside list-disc space-y-1.5 leading-relaxed">
          <li>
            <span className="text-amber-200">PTB line</span> is a dashed yellow track with a right-axis PTB pill (reference-style); then read inward: extension wings → interaction band → candles → thin shells (liquidity).
          </li>
          <li>
            <span className="text-teal-200">Reaction strength</span> is the primary text read (bodies vs wicks, clean push vs hesitation vs rejection) — direction-agnostic.
          </li>
          <li>
            <span className="text-zinc-300">Order flow</span> is CLOB mids + churn during PTB-overlap buckets only (~5s polls), not tape on Chainlink spot.
          </li>
          <li>
            Core logic: strong + extension → valid move; weak → no trade; rejection → opposite; break + hold → continuation — summarized in the trust question box.
          </li>
        </ul>
      </details>

      <p className="mt-2 text-[10px] leading-snug text-zinc-600">
        {STREAM_ATTRIBUTION_LINE} PTB: SSR anchor. Trade read is heuristic context, not a signal service.
      </p>
    </div>
  );
}
