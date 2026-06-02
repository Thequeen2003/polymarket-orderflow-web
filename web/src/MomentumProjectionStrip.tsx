import { useMemo, type ReactElement } from 'react';
import { computeMomentumProjection, type MomentumProjectionPoint, type ProjectionTick } from './momentumProjection';

function fmtCents(v01: number): string {
  if (!Number.isFinite(v01)) return '—';
  const c = v01 * 100;
  return c >= 10 ? `${c.toFixed(1)}¢` : `${c.toFixed(2)}¢`;
}

function fmtDeltaCents(d01: number): string {
  if (!Number.isFinite(d01) || Math.abs(d01) < 0.00005) return '0¢';
  const c = d01 * 100;
  return `${c >= 0 ? '+' : ''}${c.toFixed(1)}¢`;
}

function ProjectionCell(props: { point: MomentumProjectionPoint }): ReactElement {
  const { point } = props;
  const up = point.delta01 > 0.0005;
  const down = point.delta01 < -0.0005;

  const border = up ? 'border-emerald-700/40' : down ? 'border-rose-700/35' : 'border-zinc-700/40';
  const bg = up ? 'bg-emerald-950/20' : down ? 'bg-rose-950/15' : 'bg-zinc-900/20';
  const arrowClr = up ? 'text-emerald-400' : down ? 'text-rose-400' : 'text-zinc-500';
  const priceClr = up ? 'text-emerald-100' : down ? 'text-rose-100' : 'text-zinc-200';
  const deltaClr = up ? 'text-emerald-300/80' : down ? 'text-rose-300/80' : 'text-zinc-400';
  const arrow = up ? '↑' : down ? '↓' : '→';

  const confPct = Math.round(point.confidence * 100);
  const bandCents = ((point.hi01 - point.lo01) / 2 * 100).toFixed(1);

  return (
    <div
      className={`flex min-w-[4rem] shrink-0 flex-col items-center rounded-lg border ${border} ${bg} px-2 py-1.5`}
      title={`${point.label}: ${fmtCents(point.price01)} (${fmtDeltaCents(point.delta01)})\nRange: ${fmtCents(point.lo01)} – ${fmtCents(point.hi01)}\nConfidence: ${confPct}%`}
    >
      <div className="flex items-center gap-1">
        <span className="text-[8px] font-black uppercase tracking-wide text-sky-300/80">{point.label}</span>
        <span className={`text-[9px] font-bold ${arrowClr}`}>{arrow}</span>
      </div>
      <span className={`mt-0.5 font-mono text-[13px] font-black tabular-nums ${priceClr}`}>
        {fmtCents(point.price01)}
      </span>
      <span className={`font-mono text-[9px] tabular-nums ${deltaClr}`}>
        {fmtDeltaCents(point.delta01)}
      </span>
      <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-zinc-800/60">
        <div
          className={`h-full rounded-full ${up ? 'bg-emerald-500/60' : down ? 'bg-rose-500/50' : 'bg-zinc-600/50'}`}
          style={{ width: `${confPct}%` }}
        />
      </div>
      <span className="mt-0.5 font-mono text-[7px] tabular-nums text-zinc-500">
        ±{bandCents}¢
      </span>
    </div>
  );
}

const REGIME_BADGE: Record<string, { label: string; cls: string }> = {
  accelerating: { label: 'ACCEL', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  decelerating: { label: 'DECEL', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  reversing: { label: 'REVERSAL', cls: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
  steady: { label: 'STEADY', cls: 'bg-zinc-500/15 text-zinc-300 border-zinc-600/40' },
};

export function MomentumProjectionStrip(props: {
  /** Outcome token mid history (v in 0–1). */
  pts: ProjectionTick[];
  /** Tape net pressure (-100..100). */
  tapeNetPressure?: number | null;
  /** Outcome label (e.g. "UP", "DOWN"). */
  outcomeLabel?: string;
}): ReactElement | null {
  const { pts, tapeNetPressure, outcomeLabel } = props;

  const projection = useMemo(
    () => computeMomentumProjection({ pts, tapeNetPressure }),
    [pts, tapeNetPressure],
  );

  if (!projection) return null;

  const badge = REGIME_BADGE[projection.regime] ?? REGIME_BADGE['steady']!;
  const slopePerMin = projection.effectiveSlope01PerSec * 60 * 100;

  return (
    <div className="rounded-xl border border-sky-700/35 bg-sky-950/12 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-extrabold uppercase tracking-[0.14em] text-sky-200/90">
            {outcomeLabel ? `${outcomeLabel} ` : ''}Projected price
          </span>
          <span className={`rounded border px-1.5 py-px text-[7px] font-black uppercase tracking-wider ${badge.cls}`}>
            {badge.label}
          </span>
        </div>
        <div className="font-mono text-[10px] tabular-nums text-sky-100/70">
          Now <span className="font-bold text-white">{fmtCents(projection.now01)}</span>
          <span className="text-sky-300/50"> · </span>
          {slopePerMin >= 0 ? '+' : ''}{slopePerMin.toFixed(2)}¢/m
        </div>
      </div>

      <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:thin]">
        {projection.points.map((pt) => (
          <ProjectionCell key={pt.label} point={pt} />
        ))}
      </div>
    </div>
  );
}
