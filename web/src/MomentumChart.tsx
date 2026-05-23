import { useEffect, useState, type ReactElement } from 'react';
import { displayPrice } from './bookLevels';
import { seriesWindowDelta } from './chartReadouts';
import { describeMomentum } from './liveContext';

export type SeriesPoint = { t: number; v: number | null };

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
  if (min === max) return { min: min - 0.01, max: max + 0.01 };
  return { min, max };
}

function toPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  let d = `M ${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i]!.x.toFixed(2)} ${points[i]!.y.toFixed(2)}`;
  return d;
}

/** One book poll → one mid point; draw a short segment so the sparkline is visible before the second poll. */
function sparklinePath(pts: { x: number; y: number }[], pad: number, width: number): string {
  if (pts.length === 0) return '';
  if (pts.length >= 2) return toPath(pts);
  const p = pts[0]!;
  const span = Math.max(16, (width - pad * 2) * 0.14);
  const x0 = Math.max(pad + 1, p.x - span);
  return `M ${x0.toFixed(2)} ${p.y.toFixed(2)} L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
}

function fmtPtbUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function MomentumChart({
  title,
  aLabel,
  a,
  aTone,
  bLabel,
  b,
  bTone,
  lastUpdateMs,
  priceToBeatUsd,
}: {
  title: string;
  aLabel: string;
  a: SeriesPoint[];
  aTone: 'up' | 'down';
  bLabel: string;
  b: SeriesPoint[];
  bTone: 'up' | 'down';
  lastUpdateMs: number | null;
  /** SSR underlying level — shown as a horizontal reference (implied-mid chart is a different scale). */
  priceToBeatUsd?: number | null;
}): ReactElement {
  const width = 520;
  const height = 130;
  const pad = 10;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 2_000);
    return () => window.clearInterval(id);
  }, []);
  const stale = lastUpdateMs == null ? true : now - lastUpdateMs > 45_000;

  const merged = [...a, ...b].filter((p) => typeof p.v === 'number' && Number.isFinite(p.v as number));
  const vals = merged.map((p) => p.v as number);
  const { min, max } = extent(vals);
  const tMin = Math.min(...[...a, ...b].map((p) => p.t).filter(Number.isFinite));
  const tMax = Math.max(...[...a, ...b].map((p) => p.t).filter(Number.isFinite));
  const tSpan = Math.max(1, tMax - tMin);

  const toXY = (p: SeriesPoint) => {
    const x = pad + ((p.t - tMin) / tSpan) * (width - pad * 2);
    const y = pad + (1 - clamp01(((p.v ?? min) - min) / (max - min))) * (height - pad * 2);
    return { x, y };
  };

  const aPts = a.filter((p) => p.v != null).map(toXY);
  const bPts = b.filter((p) => p.v != null).map(toXY);

  const aLast = a.slice().reverse().find((p) => p.v != null)?.v ?? null;
  const bLast = b.slice().reverse().find((p) => p.v != null)?.v ?? null;

  const toneClass = (tone: 'up' | 'down') => (tone === 'up' ? 'stroke-emerald-300' : 'stroke-sky-300');
  const dotClass = (tone: 'up' | 'down') => (tone === 'up' ? 'fill-emerald-200' : 'fill-sky-200');

  const ctx = describeMomentum({ a, b });
  const da = seriesWindowDelta(a);
  const db = seriesWindowDelta(b);
  const showHalf =
    Number.isFinite(min) && Number.isFinite(max) && min <= 0.5 && max >= 0.5 && max - min > 0.02;
  const yHalf = showHalf
    ? pad + (1 - clamp01((0.5 - min) / (max - min))) * (height - pad * 2)
    : null;

  return (
    <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/35 p-4 shadow-inner shadow-black/15 ring-1 ring-white/[0.02]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[13px] font-medium tracking-wide text-zinc-200">{title}</div>
        <div
          className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
            stale ? 'border-zinc-700/40 bg-zinc-950/40 text-zinc-500' : 'border-emerald-700/40 bg-emerald-950/25 text-emerald-200'
          }`}
          title={lastUpdateMs ? `Last update ${new Date(lastUpdateMs).toLocaleTimeString()}` : 'No updates yet'}
        >
          {stale ? 'stale' : 'live'}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-400">
        <div className="rounded-md bg-zinc-900/50 px-2 py-1 font-mono" title="Implied price for this outcome from the CLOB mid">
          <span className="text-emerald-200/90">{aLabel}</span> {aLast != null ? displayPrice(aLast) : '—'}
          <span className="ml-1.5 text-zinc-500">({da.label})</span>
        </div>
        <div className="rounded-md bg-zinc-900/50 px-2 py-1 font-mono" title="Implied price for this outcome from the CLOB mid">
          <span className="text-sky-200/90">{bLabel}</span> {bLast != null ? displayPrice(bLast) : '—'}
          <span className="ml-1.5 text-zinc-500">({db.label})</span>
        </div>
        <div className="rounded-md bg-zinc-900/50 px-2 py-1 font-mono" title="Vertical scale of the chart">
          y: {displayPrice(min)}–{displayPrice(max)}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-zinc-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-sm bg-emerald-400/80" /> {aLabel}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-sm bg-sky-400/80" /> {bLabel}
        </span>
        {showHalf ? (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0 w-4 border-t border-dashed border-zinc-500" /> 0.5 reference
          </span>
        ) : null}
        {priceToBeatUsd != null ? (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0 w-4 border-t-2 border-amber-400" /> SSR PTB {fmtPtbUsd(priceToBeatUsd)}
          </span>
        ) : null}
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="mt-3 h-[140px] w-full">
        <rect x="0" y="0" width={width} height={height} rx="14" className="fill-black/25 stroke-zinc-800/40" />
        <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} className="stroke-zinc-800/40" />
        <line x1={pad} y1={pad} x2={pad} y2={height - pad} className="stroke-zinc-800/40" />
        <text x={pad + 2} y={priceToBeatUsd != null ? height - 22 : height - 2} className="fill-zinc-600" fontSize="9" fontFamily="ui-sans-serif, system-ui">
          older → newer
        </text>
        <text x={width - pad - 62} y={pad + 12} className="fill-zinc-600" fontSize="9" fontFamily="ui-sans-serif, system-ui">
          implied price ↑
        </text>
        {yHalf != null ? (
          <line
            x1={pad}
            x2={width - pad}
            y1={yHalf}
            y2={yHalf}
            className="stroke-zinc-600/50"
            strokeDasharray="4 4"
            strokeWidth="1"
          />
        ) : null}

        {aPts.length > 0 ? (
          <path d={sparklinePath(aPts, pad, width)} className={`${toneClass(aTone)} fill-none`} strokeWidth="2.2" />
        ) : null}
        {bPts.length > 0 ? (
          <path d={sparklinePath(bPts, pad, width)} className={`${toneClass(bTone)} fill-none`} strokeWidth="2.2" />
        ) : null}

        {aPts.length > 0 ? (
          <circle cx={aPts[aPts.length - 1]!.x} cy={aPts[aPts.length - 1]!.y} r="3.5" className={dotClass(aTone)} />
        ) : null}
        {bPts.length > 0 ? (
          <circle cx={bPts[bPts.length - 1]!.x} cy={bPts[bPts.length - 1]!.y} r="3.5" className={dotClass(bTone)} />
        ) : null}

        {priceToBeatUsd != null ? (
          <g aria-label="SSR price-to-beat reference">
            <line
              x1={pad}
              x2={width - pad}
              y1={height - 11}
              y2={height - 11}
              className="stroke-amber-400"
              strokeWidth={2.25}
              opacity={0.95}
            />
            <text
              x={pad + 4}
              y={height - 14}
              className="fill-amber-200/95"
              fontSize="9"
              fontFamily="ui-monospace, monospace"
            >
              SSR price-to-beat {fmtPtbUsd(priceToBeatUsd)}
            </text>
          </g>
        ) : null}
      </svg>

      <div className="mt-2 rounded-xl border border-zinc-800/40 bg-black/20 px-3 py-2 text-[11px] leading-relaxed text-zinc-400">
        <span className="font-semibold text-zinc-300">Live context:</span> {ctx.read || '—'}
      </div>

      <details className="mt-2 rounded-xl border border-zinc-800/40 bg-zinc-900/25 px-3 py-2 text-[11px] text-zinc-400">
        <summary className="cursor-pointer font-semibold text-zinc-300">How to read this chart (entries / exits)</summary>
        <ul className="mt-2 list-inside list-disc space-y-1.5 leading-relaxed text-zinc-400">
          <li>
            Each line is the <span className="text-zinc-300">mid price</span> of that outcome token (average of best bid and best ask). It
            tracks where the book implies that outcome is trading — not executed trades.
          </li>
          <li>
            <span className="text-zinc-300">Higher line</span> for an outcome means the market is pricing that side richer;{' '}
            <span className="text-zinc-300">lower</span> means cheaper vs the other line.
          </li>
          <li>
            <span className="text-zinc-300">Entry idea:</span> your effective “buy” level is near the <span className="font-mono text-zinc-300">ask</span> column
            in the book; the chart shows whether mids are drifting toward or away from where you hoped to pay.
          </li>
          <li>
            <span className="text-zinc-300">Exit idea:</span> your effective “sell” is near the <span className="font-mono text-zinc-300">bid</span> column; if mid
            is stalling under a thick ask wall, exiting into strength can be harder until asks thin.
          </li>
          <li>
            The <span className="text-zinc-300">% in window</span> badge is change from the oldest to newest point in the visible history — short-term pulse only.
          </li>
        </ul>
      </details>

      <p className="mt-2 text-[10px] leading-snug text-zinc-600">
        Mid-price sparkline from the CLOB — readout of quoted prices, not a prediction. Cross-check the ladder before sizing.
        {priceToBeatUsd != null
          ? ' Amber rule at the bottom is the SSR price-to-beat in USD (underlying), not a level on the implied-mid Y scale — use Spot vs PTB for true alignment.'
          : ''}
      </p>
    </div>
  );
}

