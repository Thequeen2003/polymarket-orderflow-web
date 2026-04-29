import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { displayPrice } from './bookLevels';
import { orderFlowPlainRead } from './chartReadouts';
import type { BookSnapshot } from './orderflowMetrics';

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

export function OrderFlowChart({
  title,
  series,
  lastUpdateMs,
  priceToBeatUsd,
  compact = false,
}: {
  title: string;
  series: BookSnapshot[];
  lastUpdateMs: number | null;
  /** SSR underlying level — horizontal reference (mid panel is implied price, not USD spot). */
  priceToBeatUsd?: number | null;
  /** Slimmer chart + less chrome for Signals desk strip. */
  compact?: boolean;
}): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  const stale = lastUpdateMs == null ? true : now - lastUpdateMs > 20_000;

  const width = 520;
  const height = compact ? 150 : 220;
  const pad = 10;
  const plotH = height - pad * 2;
  const topH = Math.floor(plotH * 0.58);
  const bottomH = plotH - topH - 10;
  const topY0 = pad;
  const bottomY0 = pad + topH + 10;

  const cleaned = useMemo(() => series.filter((p) => Number.isFinite(p.t)), [series]);
  const tMin = cleaned.length ? Math.min(...cleaned.map((p) => p.t)) : 0;
  const tMax = cleaned.length ? Math.max(...cleaned.map((p) => p.t)) : 1;
  const tSpan = Math.max(1, tMax - tMin);

  const mids = cleaned.map((p) => p.mid).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const { min: midMin, max: midMax } = extent(mids);
  const churns = cleaned.map((p) => p.churn).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const churnMax = churns.length ? Math.max(...churns) : 1;

  const xyMid = (p: BookSnapshot) => {
    const x = pad + ((p.t - tMin) / tSpan) * (width - pad * 2);
    const v = p.mid ?? midMin;
    const y = topY0 + (1 - clamp01((v - midMin) / (midMax - midMin))) * topH;
    return { x, y };
  };

  const midPts = cleaned.filter((p) => p.mid != null).map(xyMid);

  const last = cleaned[cleaned.length - 1];
  const midLast = last?.mid ?? null;
  const imbLast = last?.imbalance ?? null;
  const churnLast = last?.churn ?? null;

  const plainRead = useMemo(() => orderFlowPlainRead(cleaned), [cleaned]);

  const bars = cleaned.map((p) => {
    const x = pad + ((p.t - tMin) / tSpan) * (width - pad * 2);
    const imb = p.imbalance ?? 0;
    const churn = p.churn ?? 0;
    return { x, imb, churn };
  });

  return (
    <div
      className={`rounded-2xl border border-zinc-800/50 bg-zinc-950/35 shadow-inner shadow-black/15 ring-1 ring-white/[0.02] ${compact ? 'p-2.5' : 'p-4'}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className={`font-semibold tracking-wide text-zinc-200 ${compact ? 'text-[12px]' : 'text-[15px]'}`}>{title}</div>
        <div
          className={`rounded-full border font-semibold uppercase tracking-wide ${
            compact ? 'px-2 py-1 text-[10px]' : 'px-3 py-1.5 text-[13px]'
          } ${
            stale ? 'border-zinc-700/40 bg-zinc-950/40 text-zinc-500' : 'border-emerald-700/40 bg-emerald-950/25 text-emerald-200'
          }`}
          title={lastUpdateMs ? `Last update ${new Date(lastUpdateMs).toLocaleTimeString()}` : 'No updates yet'}
        >
          {stale ? 'stale' : 'live'}
        </div>
      </div>

      <div className={`mt-2 flex flex-wrap gap-2 text-zinc-300 ${compact ? 'gap-1.5 text-[11px]' : 'text-[13px]'}`}>
        <div className={`rounded-md bg-zinc-900/50 font-mono ${compact ? 'px-2 py-1' : 'px-2.5 py-1.5'}`}>
          mid {midLast != null ? displayPrice(midLast) : '—'}
        </div>
        <div className={`rounded-md bg-zinc-900/50 font-mono ${compact ? 'px-2 py-1' : 'px-2.5 py-1.5'}`}>
          imbalance {imbLast != null ? `${(imbLast * 100).toFixed(0)}%` : '—'}
        </div>
        <div
          className={`rounded-md bg-zinc-900/50 font-mono ${compact ? 'px-2 py-1' : 'px-2.5 py-1.5'}`}
          title="Sum of absolute size changes on tracked levels — book reshuffling"
        >
          churn {churnLast != null ? churnLast.toFixed(1) : '—'}
        </div>
      </div>

      <div className={`mt-2 flex flex-wrap items-center gap-3 text-zinc-500 ${compact ? 'hidden' : 'text-[12px]'}`}>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-2 rounded-sm bg-emerald-400/60" /> bid-heavy
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-2 rounded-sm bg-rose-400/60" /> ask-heavy
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-0.5 bg-amber-200/70" /> churn tick
        </span>
        {priceToBeatUsd != null ? (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0 w-4 border-t-2 border-amber-400" /> SSR PTB {fmtPtbUsd(priceToBeatUsd)}
          </span>
        ) : null}
      </div>

      <div
        className={`mt-2 rounded-xl border border-zinc-800/40 bg-black/20 leading-relaxed text-zinc-300 ${
          compact ? 'px-2 py-1.5 text-[11px]' : 'px-3 py-2.5 text-[13px]'
        }`}
      >
        <span className="font-semibold text-zinc-300">Readout:</span> {plainRead}
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className={`mt-2 w-full ${compact ? 'h-[150px]' : 'mt-3 h-[240px]'}`}>
        <rect x="0" y="0" width={width} height={height} rx="14" className="fill-black/25 stroke-zinc-800/40" />

        {/* mid plot box */}
        <rect x={pad} y={topY0} width={width - pad * 2} height={topH} rx="10" className="fill-transparent stroke-zinc-800/30" />
        <text x={pad + 8} y={topY0 + 16} className="fill-zinc-500" fontSize="12" fontFamily="ui-monospace, monospace">
          mid (price momentum)
        </text>
        {midPts.length > 0 ? (
          <path d={sparklinePath(midPts, pad, width)} className="stroke-indigo-300 fill-none" strokeWidth="2.2" />
        ) : null}
        {midPts.length > 0 ? (
          <circle cx={midPts[midPts.length - 1]!.x} cy={midPts[midPts.length - 1]!.y} r="3.5" className="fill-indigo-200" />
        ) : null}

        {/* flow plot box */}
        <rect
          x={pad}
          y={bottomY0}
          width={width - pad * 2}
          height={bottomH}
          rx="10"
          className="fill-transparent stroke-zinc-800/30"
        />
        <text x={pad + 8} y={bottomY0 + 16} className="fill-zinc-500" fontSize="12" fontFamily="ui-monospace, monospace">
          order-flow (imbalance + churn)
        </text>
        {/* zero line */}
        <line
          x1={pad}
          x2={width - pad}
          y1={bottomY0 + bottomH / 2}
          y2={bottomY0 + bottomH / 2}
          className="stroke-zinc-800/40"
        />
        {bars.map((b, i) => {
          const w = 3.2;
          const hImb = (bottomH / 2) * clamp01(Math.abs(b.imb));
          const y0 = bottomY0 + bottomH / 2;
          const y = b.imb >= 0 ? y0 - hImb : y0;
          const h = hImb;
          const churnH = (bottomH / 2) * clamp01(b.churn / churnMax);
          return (
            <g key={i}>
              {/* imbalance bar */}
              <rect
                x={b.x - w / 2}
                y={y}
                width={w}
                height={h}
                rx="1.2"
                className={b.imb >= 0 ? 'fill-emerald-400/60' : 'fill-rose-400/60'}
              />
              {/* churn spike (thin) */}
              <rect x={b.x + w / 2 + 1} y={bottomY0 + bottomH - churnH} width="1.5" height={churnH} className="fill-amber-200/70" />
            </g>
          );
        })}

        {priceToBeatUsd != null ? (
          <g aria-label="SSR price-to-beat reference">
            <line
              x1={pad}
              x2={width - pad}
              y1={height - 4}
              y2={height - 4}
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

      <details
        className={`mt-2 rounded-xl border border-zinc-800/40 bg-zinc-900/25 px-3 py-2.5 text-[13px] text-zinc-400 ${compact ? 'hidden' : ''}`}
      >
        <summary className="cursor-pointer font-semibold text-zinc-300">What this means for entries / exits</summary>
        <ul className="mt-2 list-inside list-disc space-y-1.5 leading-relaxed">
          <li>
            <span className="text-zinc-300">Mid rising</span> with <span className="text-zinc-300">imbalance bid-heavy</span> often reads as
            support under the move (people stacking bids). The opposite suggests offers pressing.
          </li>
          <li>
            <span className="text-zinc-300">Churn spikes</span> without mid moving can mean liquidity games (walls appearing/vanishing) — be
            cautious about chasing mids alone.
          </li>
          <li>
            For <span className="text-zinc-300">entry</span>, combine this panel with the ladder: your first paid price is still at the ask;
            for <span className="text-zinc-300">exit</span>, watch whether bids thicken (better lift) or pull (worse exit).
          </li>
        </ul>
      </details>

      <p className={`mt-2 text-[12px] leading-snug text-zinc-600 ${compact ? 'hidden' : ''}`}>
        Imbalance ≈ (bid depth − ask depth) / (bid depth + ask depth) on the top ~12 levels. Churn = size-change across those levels between
        snapshots (not tape/trades).
        {priceToBeatUsd != null
          ? ' The amber rule at the bottom marks SSR price-to-beat in USD for context; mid panel is still implied price, not spot USD.'
          : ''}
      </p>
    </div>
  );
}

