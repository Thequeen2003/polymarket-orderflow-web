import type { ReactElement } from 'react';
import { buildSpotProjectionGrid, type SpotProjectionCell } from './spotPriceProjection';

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtDelta(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  const s = n >= 0 ? '+' : '-';
  return `${s}$${Math.abs(n).toFixed(0)}`;
}

function deltaTone(delta: number): string {
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.005) return 'text-zinc-400';
  return delta > 0 ? 'text-emerald-300' : 'text-rose-300';
}

function ProjectionCellView(props: { cell: SpotProjectionCell; compact?: boolean }): ReactElement {
  const { cell, compact } = props;
  const ok = Number.isFinite(cell.price);
  return (
    <div
      className={`flex shrink-0 flex-col items-center rounded-lg border border-indigo-800/35 bg-indigo-950/20 px-1.5 py-1 ${compact ? 'min-w-[3.1rem]' : 'min-w-[3.75rem]'}`}
      title={
        ok
          ? `Linear proj @ ${cell.label}: ${fmtUsd(cell.price)} (${fmtDelta(cell.deltaUsd)} vs now)\nHorizon ${Math.round(cell.horizonSec)}s · tick slope extrapolation`
          : `${cell.label}: round end unknown`
      }
    >
      <span className="text-[8px] font-bold uppercase tracking-wide text-indigo-300/80">{cell.label}</span>
      <span className="mt-0.5 font-mono text-[10px] font-semibold tabular-nums text-indigo-50">{fmtUsd(ok ? cell.price : null)}</span>
      {ok ? (
        <span className={`mt-0.5 font-mono text-[8px] tabular-nums ${deltaTone(cell.deltaUsd)}`}>{fmtDelta(cell.deltaUsd)}</span>
      ) : (
        <span className="mt-0.5 text-[8px] text-zinc-600">—</span>
      )}
    </div>
  );
}

export function SpotPriceProjectionGrid(props: {
  spotLast: number | null;
  slopeUsdPerSec: number | null;
  endsInMs?: number | null;
  /** e.g. "BTC" for header */
  assetLabel?: string;
}): ReactElement | null {
  const { spotLast, slopeUsdPerSec, endsInMs, assetLabel } = props;
  if (spotLast == null || slopeUsdPerSec == null) return null;

  const grid = buildSpotProjectionGrid({ spotLast, slopeUsdPerSec, endsInMs });
  if (!grid) return null;

  const slopePerMin = grid.slopeUsdPerSec * 60;

  return (
    <div className="mt-2 rounded-xl border border-indigo-700/40 bg-indigo-950/15 px-3 py-2.5 ring-1 ring-indigo-900/25">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div
          className="text-[9px] font-extrabold uppercase tracking-[0.16em] text-indigo-200/90"
          title="Linear extrapolation from latest tick slope — not a forecast guarantee"
        >
          Projected {assetLabel ? `${assetLabel} ` : ''}spot
        </div>
        <div className="font-mono text-[10px] tabular-nums text-indigo-100/80">
          Now {fmtUsd(grid.currentSpot)}
          <span className="text-indigo-300/60"> · </span>
          Slope {slopePerMin >= 0 ? '+' : ''}
          {slopePerMin.toFixed(2)}/m
        </div>
      </div>

      <div className="mt-2">
        <div className="text-[8px] font-semibold uppercase tracking-wide text-indigo-400/70">1m → 30m</div>
        <div className="mt-1 flex gap-1 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:thin]">
          {grid.minuteHorizons.map((cell) => (
            <ProjectionCellView key={cell.label} cell={cell} compact />
          ))}
        </div>
      </div>

      <div className="mt-2 border-t border-indigo-800/30 pt-2">
        <div className="text-[8px] font-semibold uppercase tracking-wide text-indigo-400/70">5m · 15m · 30m · 1h · EOD</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {grid.longerHorizons.map((cell) => (
            <ProjectionCellView key={cell.label} cell={cell} />
          ))}
        </div>
      </div>
    </div>
  );
}
