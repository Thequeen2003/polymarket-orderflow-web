import { useId, useMemo, useState, type ReactElement } from 'react';
import { fmtSpotUsd, fmtSpotUsdAxis, fmtSpotUsdSigned } from './fmtSpotUsd';
import { ptbTouchEpsilonUsd } from './spotVsPtb';
import type { BinaryCandle } from './binaryCandlePredictor';

/** OHLC bar with explicit time range — matches Spot vs PTB bucket shape. */
export type OhlcBar = {
  t0: number;
  t1: number;
  o: number;
  h: number;
  l: number;
  c: number;
};

export function ohlcBarsFromBinary(candles: BinaryCandle[], intervalMs: number): OhlcBar[] {
  return candles.map((c) => ({ t0: c.t, t1: c.t + intervalMs, o: c.o, h: c.h, l: c.l, c: c.c }));
}

const W = 1040;
const H = 680;
const PAD_L = 18;
const PAD_R = 64;
const PAD_Y = 18;

function buildEvenXTicks(tMin: number, tMax: number): number[] {
  const span = Math.max(1, tMax - tMin);
  const n = span < 120_000 ? 8 : span < 3_600_000 ? 7 : 6;
  const step = span / (n - 1);
  return Array.from({ length: n }, (_, i) => tMin + i * step);
}

function fmtPctSigned(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function statusFor(price: number, level: number, band: number, recentMove: number): 'UP BIAS' | 'DOWN BIAS' | 'AT PTB' {
  if (price > level + band && recentMove >= 0) return 'UP BIAS';
  if (price < level - band && recentMove <= 0) return 'DOWN BIAS';
  if (price > level + band * 1.35) return 'UP BIAS';
  if (price < level - band * 1.35) return 'DOWN BIAS';
  return 'AT PTB';
}

export function SpotStyleOhlcChart(props: {
  bars: OhlcBar[];
  livePrice: number | null;
  /** Strike / PTB level — yellow line + heat zones. */
  strikePrice: number | null;
  chartTitle?: string;
  strikeLabel?: string;
  /** Default OHLC for binary desks; LINE matches Spot vs PTB default. */
  defaultDisplayMode?: 'line' | 'ohlc';
  /** Taller plot like Signals embed. */
  roomy?: boolean;
  /** Expiry countdown (binary) — shown in header like “Time remaining”. */
  countdownMs?: number | null;
  formatCountdown?: (ms: number) => string;
  ariaLabel?: string;
}): ReactElement {
  const {
    bars,
    livePrice,
    strikePrice,
    chartTitle = 'BTC / USDT',
    strikeLabel = 'STRIKE',
    defaultDisplayMode = 'ohlc',
    roomy = true,
    countdownMs = null,
    formatCountdown: fmtCountdown,
    ariaLabel = 'Spot-style OHLC chart',
  } = props;

  const gradId = useId().replace(/:/g, '');
  const [displayMode, setDisplayMode] = useState<'line' | 'ohlc'>(defaultDisplayMode);

  const model = useMemo(() => {
    if (bars.length < 1) return null;
    const last = livePrice ?? bars[bars.length - 1]!.c;
    const first = bars[0]!.o;
    const recentBase = bars[Math.max(0, bars.length - 7)]?.c ?? first;
    const recentMove = last - recentBase;
    const pctChange = Math.abs(first) > 1e-12 ? ((last - first) / first) * 100 : 0;

    let spotMin = Infinity;
    let spotMax = -Infinity;
    for (const b of bars) {
      if (b.l < spotMin) spotMin = b.l;
      if (b.h > spotMax) spotMax = b.h;
    }
    if (livePrice != null && Number.isFinite(livePrice)) {
      if (livePrice < spotMin) spotMin = livePrice;
      if (livePrice > spotMax) spotMax = livePrice;
    }
    if (!Number.isFinite(spotMin)) return null;

    const level = strikePrice ?? last;
    const pts = bars.map((b) => ({ t: b.t0, v: b.c }));
    const band = strikePrice != null ? ptbTouchEpsilonUsd(pts, level) : Math.max(level * 8e-5, (spotMax - spotMin) * 0.08, 0.35);

    let plotMin: number;
    let plotMax: number;
    if (strikePrice != null && Number.isFinite(strikePrice)) {
      const needAbove = Math.max(0, spotMax - strikePrice);
      const needBelow = Math.max(0, strikePrice - spotMin);
      const halfSpan = Math.max(needAbove, needBelow, Math.abs(strikePrice) * 3e-5, 1);
      plotMin = strikePrice - halfSpan * 1.08;
      plotMax = strikePrice + halfSpan * 1.08;
    } else {
      const pad = Math.max((spotMax - spotMin) * 0.12, level * 3e-5, 1);
      plotMin = spotMin - pad;
      plotMax = spotMax + pad;
    }
    if (!(plotMax > plotMin)) return null;

    const maxAbs = strikePrice != null ? Math.max(Math.abs(last - strikePrice), band * 1.5) : spotMax - spotMin;
    const status = strikePrice != null ? statusFor(last, strikePrice, band, recentMove) : recentMove >= 0 ? 'UP BIAS' : 'DOWN BIAS';

    return {
      last,
      first,
      recentMove,
      pctChange,
      plotMin,
      plotMax,
      band,
      maxAbs,
      status,
      tMin: bars[0]!.t0,
      tMax: bars[bars.length - 1]!.t1,
    };
  }, [bars, livePrice, strikePrice]);

  const svgHeight = H;
  const padL = PAD_L;
  const padR = PAD_R;
  const padY = PAD_Y;
  const innerW = W - padL - padR;
  const innerH = H - padY * 2;

  const chartSvgClass = roomy
    ? 'block h-full min-h-[min(52svh,520px)] w-full max-w-none rounded-[20px] bg-[#0a0f16]'
    : 'block h-full min-h-[min(54vh,620px)] max-h-[min(88vh,960px)] w-full rounded-[24px] bg-[#0a0f16] [contain:strict]';

  if (!model || bars.length < 1) {
    return (
      <div className="flex min-h-0 flex-col rounded-[30px] border border-zinc-800/90 bg-[#0b1018] ring-1 ring-zinc-700/40 shadow-[0_28px_80px_rgba(0,0,0,0.35)]">
        <header className="shrink-0 border-b border-zinc-800/80 bg-[#0b1018] px-4 py-3 sm:px-5">
          <span className="text-lg font-semibold tracking-tight text-zinc-100">{chartTitle}</span>
        </header>
        <div className="flex min-h-[280px] items-center justify-center px-4 py-12 text-sm text-zinc-500">Waiting for candle data…</div>
      </div>
    );
  }

  const span = Math.max(1e-9, model.plotMax - model.plotMin);
  const tSpan = Math.max(1, model.tMax - model.tMin);
  const yPrice = (v: number) => padY + (1 - (v - model.plotMin) / span) * innerH;
  const xTime = (t: number) => padL + ((t - model.tMin) / tSpan) * innerW;
  const level = strikePrice ?? model.last;
  const yBeat = yPrice(level);
  const yBandTop = yPrice(level + model.band);
  const yBandBottom = yPrice(level - model.band);
  const tickPrices = Array.from({ length: 5 }, (_, i) => model.plotMin + ((model.plotMax - model.plotMin) * i) / 4);
  const xTickTs = buildEvenXTicks(model.tMin, model.tMax);
  const heatIntensity = strikePrice != null ? Math.min(1, Math.abs(model.last - strikePrice) / Math.max(model.maxAbs, model.band * 1.5)) : 0.35;

  const closeSeries = bars.map((c) => ({ x: xTime((c.t0 + c.t1) / 2), y: yPrice(c.c), v: c.c }));
  const lineStroke = model.recentMove >= 0 ? 'rgb(74 222 128)' : 'rgb(251 113 133)';
  const lineFill = model.recentMove >= 0 ? 'rgba(74,222,128,0.14)' : 'rgba(251,113,133,0.14)';
  const lastT = bars[bars.length - 1]!.t1;
  const lastV = livePrice ?? bars[bars.length - 1]!.c;

  return (
    <div className="flex min-h-0 flex-col rounded-[30px] border border-zinc-800/90 bg-[#0b1018] ring-1 ring-zinc-700/40 shadow-[0_28px_80px_rgba(0,0,0,0.35)]">
      <header className="shrink-0 border-b border-zinc-800/80 bg-[#0b1018] px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="truncate text-lg font-semibold tracking-tight text-zinc-100 sm:text-xl">{chartTitle}</span>
            <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-zinc-50 sm:text-3xl">{fmtSpotUsd(model.last)}</span>
            <span className={`text-sm font-semibold tabular-nums ${model.recentMove >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {fmtSpotUsdSigned(model.recentMove)}{' '}
              <span className="font-normal text-zinc-500">({fmtPctSigned(model.pctChange)})</span>
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {countdownMs != null && fmtCountdown ? (
              <div className="rounded-xl border border-amber-900/45 bg-amber-950/35 px-3 py-2 text-center shadow-sm shadow-black/20">
                <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-amber-200/85">Expiry</div>
                <div className="font-mono text-lg font-bold tabular-nums leading-tight text-amber-50">{fmtCountdown(countdownMs)}</div>
              </div>
            ) : null}
            <div className="inline-flex rounded-2xl border border-zinc-800/80 bg-black/25 p-1 shadow-inner shadow-black/30">
              <button
                type="button"
                onClick={() => setDisplayMode('line')}
                className={`rounded-xl px-3 py-2 text-[11px] font-semibold sm:px-4 sm:text-[12px] ${
                  displayMode === 'line' ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                LINE
              </button>
              <button
                type="button"
                onClick={() => setDisplayMode('ohlc')}
                className={`rounded-xl px-3 py-2 text-[11px] font-semibold sm:px-4 sm:text-[12px] ${
                  displayMode === 'ohlc' ? 'bg-zinc-600 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                OHLC
              </button>
            </div>
            <div
              className={`rounded-2xl border px-3 py-2 text-[10px] font-semibold uppercase tracking-wide ${
                model.status === 'UP BIAS'
                  ? 'border-emerald-800/50 bg-emerald-950/30 text-emerald-200'
                  : model.status === 'DOWN BIAS'
                    ? 'border-rose-800/50 bg-rose-950/30 text-rose-200'
                    : 'border-zinc-700/60 bg-zinc-900/40 text-zinc-200'
              }`}
            >
              {model.status}
            </div>
          </div>
        </div>
      </header>

      <div className="overflow-x-hidden overflow-y-visible px-1.5 pt-1 sm:px-2">
        <svg viewBox={`0 0 ${W} ${svgHeight}`} className={chartSvgClass} preserveAspectRatio="xMidYMid meet" role="img" aria-label={ariaLabel}>
          <defs>
            <linearGradient id={`ptbFocusBand-${gradId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(161, 161, 170, 0.18)" />
              <stop offset="100%" stopColor="rgba(161, 161, 170, 0.06)" />
            </linearGradient>
            <linearGradient id={`heatAbove-${gradId}`} gradientUnits="userSpaceOnUse" x1={0} y1={yBeat} x2={0} y2={padY}>
              <stop offset="0%" stopColor="rgb(34 197 94)" stopOpacity={0} />
              <stop offset="100%" stopColor="rgb(21 128 61)" stopOpacity={0.06 + 0.22 * heatIntensity} />
            </linearGradient>
            <linearGradient id={`heatBelow-${gradId}`} gradientUnits="userSpaceOnUse" x1={0} y1={yBeat} x2={0} y2={padY + innerH}>
              <stop offset="0%" stopColor="rgb(248 113 113)" stopOpacity={0} />
              <stop offset="100%" stopColor="rgb(185 28 28)" stopOpacity={0.06 + 0.22 * heatIntensity} />
            </linearGradient>
          </defs>

          <rect x="0" y="0" width={W} height={svgHeight} fill="#0a0f16" />

          {strikePrice != null ? (
            <>
              <rect
                x={padL}
                y={Math.min(yBandTop, yBandBottom)}
                width={innerW}
                height={Math.max(12, Math.abs(yBandBottom - yBandTop))}
                fill={`url(#ptbFocusBand-${gradId})`}
              />
              <text x={padL + 8} y={Math.min(yBandTop, yBandBottom) - 6} fill="rgb(161 161 170)" fontSize="10" fontWeight="700">
                [ NO EDGE ZONE ]
              </text>
              <rect x={padL} y={padY} width={innerW} height={Math.max(0, yBeat - padY)} fill={`url(#heatAbove-${gradId})`} className="pointer-events-none" />
              <rect x={padL} y={yBeat} width={innerW} height={Math.max(0, padY + innerH - yBeat)} fill={`url(#heatBelow-${gradId})`} className="pointer-events-none" />
            </>
          ) : null}

          {closeSeries.length >= 2 && strikePrice != null ? (
            <path
              d={`M ${closeSeries[0]!.x.toFixed(1)} ${yBeat.toFixed(1)} ${closeSeries.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')} L ${closeSeries[closeSeries.length - 1]!.x.toFixed(1)} ${yBeat.toFixed(1)} Z`}
              fill={model.recentMove >= 0 ? 'rgba(74,222,128,0.08)' : 'rgba(251,113,133,0.08)'}
              className="pointer-events-none"
            />
          ) : null}

          {tickPrices.map((tp, i) => (
            <g key={`grid-${i}`}>
              <line x1={padL} x2={padL + innerW} y1={yPrice(tp)} y2={yPrice(tp)} stroke="rgba(39,39,42,0.8)" strokeWidth="1" />
              <text
                x={W - 4}
                y={yPrice(tp) + 4}
                fill="rgb(228 228 231)"
                fontSize={12}
                fontFamily="ui-monospace, monospace"
                fontWeight={600}
                textAnchor="end"
                stroke="rgb(10 15 22)"
                strokeWidth={2.4}
                paintOrder="stroke"
              >
                {fmtSpotUsdAxis(tp)}
              </text>
            </g>
          ))}

          <text
            x={padL + 96}
            y={padY + 16}
            fontSize="12"
            fontWeight="800"
            fill="rgb(212 212 216)"
            stroke="rgb(10 15 22)"
            strokeWidth="2.2"
            strokeLinejoin="round"
            paintOrder="stroke fill"
          >
            HIGHER $
          </text>
          <text
            x={padL + 96}
            y={padY + innerH - 3}
            fontSize="12"
            fontWeight="800"
            fill="rgb(212 212 216)"
            stroke="rgb(10 15 22)"
            strokeWidth="2.2"
            strokeLinejoin="round"
            paintOrder="stroke fill"
          >
            LOWER $
          </text>

          {displayMode === 'line' ? (() => {
            const series = closeSeries;
            if (series.length < 2) return null;
            const fill_d = `M ${series[0]!.x.toFixed(1)} ${(padY + innerH).toFixed(1)} ${series.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')} L ${series[series.length - 1]!.x.toFixed(1)} ${(padY + innerH).toFixed(1)} Z`;
            let upD = '';
            let dnD = '';
            for (let i = 1; i < series.length; i++) {
              const prev = series[i - 1]!;
              const cur = series[i]!;
              const seg = `M${prev.x.toFixed(1)} ${prev.y.toFixed(1)}L${cur.x.toFixed(1)} ${cur.y.toFixed(1)}`;
              if (cur.v >= prev.v) upD += seg;
              else dnD += seg;
            }
            return (
              <>
                <path d={fill_d} fill={lineFill} className="pointer-events-none" />
                {upD ? <path d={upD} fill="none" stroke="rgb(74 222 128)" strokeWidth={3.35} strokeLinecap="round" /> : null}
                {dnD ? <path d={dnD} fill="none" stroke="rgb(248 113 113)" strokeWidth={3.35} strokeLinecap="round" /> : null}
              </>
            );
          })() : (
            bars.map((c, i) => {
              const x0 = xTime(c.t0);
              const x1 = xTime(c.t1);
              const xc = (x0 + x1) / 2;
              const slotW = x1 - x0;
              const bodyW = Math.max(24, Math.min(slotW * 0.86, innerW * 0.1));
              const yO = yPrice(c.o);
              const yC = yPrice(c.c);
              const yH = yPrice(c.h);
              const yL = yPrice(c.l);
              const bullish = c.c >= c.o;
              const bodyTop = Math.min(yO, yC);
              const bodyBot = Math.max(yO, yC);
              const rawBodyH = bodyBot - bodyTop;
              const bodyH = Math.max(6, rawBodyH);
              const bodyY = bodyTop - (bodyH - rawBodyH) / 2;
              const wickColor = bullish ? 'rgb(34 197 94)' : 'rgb(239 68 68)';
              const bodyFill = bullish ? 'rgb(22 163 74)' : 'rgb(220 38 38)';
              const bodyStroke = bullish ? 'rgb(74 222 128)' : 'rgb(248 113 113)';
              return (
                <g key={`candle-${i}`}>
                  <line x1={xc} x2={xc} y1={yH} y2={bodyY} stroke={wickColor} strokeWidth={2.1} />
                  <line x1={xc} x2={xc} y1={bodyY + bodyH} y2={yL} stroke={wickColor} strokeWidth={2.1} />
                  <rect x={xc - bodyW / 2} y={bodyY} width={bodyW} height={bodyH} fill={bodyFill} stroke={bodyStroke} strokeWidth={1.55} />
                </g>
              );
            })
          )}

          {strikePrice != null ? (
            <>
              <line x1={padL} x2={padL + innerW} y1={yBeat} y2={yBeat} stroke="rgb(253 224 71)" strokeWidth={9} strokeLinecap="round" opacity={0.18} />
              <line x1={padL} x2={padL + innerW} y1={yBeat} y2={yBeat} stroke="rgb(250 234 80)" strokeWidth={3} strokeLinecap="round" />
              <text x={padL + 8} y={yBeat - 10} fill="rgb(253 224 71)" fontSize="11" fontWeight="800">
                {strikeLabel}
              </text>
              <rect x={W - padR - 136} y={Math.max(padY + 8, yBeat - 14)} width="128" height="24" rx="12" fill="rgb(250 234 80)" />
              <text x={W - padR - 72} y={Math.max(padY + 24, yBeat + 4)} textAnchor="middle" fill="#0a0a0a" fontSize="11" fontWeight="800">
                {strikeLabel} {fmtSpotUsd(strikePrice)}
              </text>
            </>
          ) : null}

          <circle cx={xTime(lastT)} cy={yPrice(lastV)} r={7} fill="white" stroke={lineStroke} strokeWidth={2.5} />

          {xTickTs.map((ts, i) => (
            <text
              key={`xt-${i}`}
              x={xTime(ts)}
              y={svgHeight - 4}
              textAnchor="middle"
              fill="rgb(113 113 122)"
              fontSize="9"
              fontFamily="ui-monospace, monospace"
            >
              {new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}
