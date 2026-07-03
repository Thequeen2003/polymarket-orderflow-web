import type { ReactElement } from 'react';
import type { DeskMomentumPhase, DeskMomentumReadout } from './deskMomentumTracker';

const PHASE_STYLE: Record<
  DeskMomentumPhase,
  { ring: string; badge: string; label: string }
> = {
  climbing: {
    ring: 'border-emerald-700/45 bg-emerald-950/18 ring-emerald-900/20',
    badge: 'border-emerald-500/45 bg-emerald-950/45 text-emerald-100',
    label: 'Climbing',
  },
  stagnating: {
    ring: 'border-amber-600/50 bg-amber-950/25 ring-amber-900/22',
    badge: 'border-amber-500/45 bg-amber-950/45 text-amber-50',
    label: 'Stalling',
  },
  reversing: {
    ring: 'border-rose-700/50 bg-rose-950/28 ring-rose-900/25',
    badge: 'border-rose-500/45 bg-rose-950/45 text-rose-50',
    label: 'Reversing',
  },
  switched: {
    ring: 'border-fuchsia-700/50 bg-fuchsia-950/28 ring-fuchsia-900/25',
    badge: 'border-fuchsia-500/45 bg-fuchsia-950/45 text-fuchsia-50',
    label: 'Switched',
  },
  idle: {
    ring: 'border-zinc-700/55 bg-zinc-950/35 ring-white/[0.03]',
    badge: 'border-zinc-600/45 bg-zinc-900/50 text-zinc-300',
    label: 'Tracking',
  },
};

function TrailDots(props: { trail: number[]; current: number; peak: number }): ReactElement {
  const { trail, current, peak } = props;
  if (!trail.length) {
    return <span className="font-mono text-zinc-500">—</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1 font-mono text-[11px] tabular-nums">
      {trail.map((c, i) => (
        <span key={`${c}-${i}`} className="inline-flex items-center gap-1">
          {i > 0 ? <span className="text-zinc-600">→</span> : null}
          <span
            className={`rounded px-1 py-0.5 font-bold ${
              c >= peak - 0.05 ? 'bg-emerald-500/20 text-emerald-100' : 'bg-zinc-800/80 text-zinc-300'
            }`}
          >
            {c.toFixed(1)}¢
          </span>
        </span>
      ))}
      {current < peak - 0.4 ? (
        <>
          <span className="text-zinc-600">→</span>
          <span className="rounded bg-amber-500/15 px-1 py-0.5 font-bold text-amber-100">{current.toFixed(1)}¢</span>
        </>
      ) : null}
    </span>
  );
}

export function DeskMomentumTrackerStrip(props: {
  readout: DeskMomentumReadout;
  compact?: boolean;
}): ReactElement {
  const { readout, compact = false } = props;
  const style = PHASE_STYLE[readout.phase];

  return (
    <div className={`rounded-xl border px-3 py-2.5 ring-1 ${style.ring}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-500">Momentum tracker</div>
          <div className="mt-0.5 text-[12px] font-bold leading-snug text-zinc-100">{readout.headline}</div>
        </div>
        <span
          className={`shrink-0 rounded-lg border px-2 py-1 text-[10px] font-black uppercase tracking-wide ${style.badge}`}
        >
          {style.label}
        </span>
      </div>

      {!compact ? (
        <>
          <div className="mt-2">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Mid trail</div>
            <div className="mt-1">
              <TrailDots trail={readout.midTrailCents} current={readout.currentMidCents} peak={readout.peakMidCents} />
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] tabular-nums text-zinc-500">
            <span>
              Peak <span className="font-bold text-zinc-200">{readout.peakMidCents.toFixed(1)}¢</span>
            </span>
            <span>
              Now <span className="font-bold text-zinc-200">{readout.currentMidCents.toFixed(1)}¢</span>
            </span>
            {readout.deskTpPeakCents != null ? (
              <span>
                Desk TP{' '}
                <span className="font-bold text-violet-200/90">
                  {readout.deskTpNowCents != null
                    ? `${readout.deskTpPeakCents.toFixed(1)} → ${readout.deskTpNowCents.toFixed(1)}¢`
                    : `${readout.deskTpPeakCents.toFixed(1)}¢`}
                </span>
              </span>
            ) : null}
            {readout.deskTpDropCents != null && readout.deskTpDropCents >= 0.5 ? (
              <span className="text-amber-300/90">−{readout.deskTpDropCents.toFixed(1)}¢ desk TP</span>
            ) : null}
          </div>
          <p className="mt-1.5 text-[10px] leading-snug text-zinc-400">{readout.detail}</p>
        </>
      ) : (
        <p className="mt-1 text-[10px] leading-snug text-zinc-400">{readout.detail}</p>
      )}
    </div>
  );
}
