import type { ReactElement } from 'react';
import type { PositionDeskSignal } from './positionDeskSignal';

const STYLE: Record<
  PositionDeskSignal['severity'],
  { ring: string; badge: string; bar: string }
> = {
  danger: {
    ring: 'border-rose-600/55 bg-rose-950/35 ring-rose-900/30',
    badge: 'border-rose-500/50 bg-rose-950/50 text-rose-50',
    bar: 'bg-rose-400/85',
  },
  warn: {
    ring: 'border-amber-600/50 bg-amber-950/28 ring-amber-900/25',
    badge: 'border-amber-500/45 bg-amber-950/45 text-amber-50',
    bar: 'bg-amber-300/85',
  },
  profit: {
    ring: 'border-teal-600/50 bg-teal-950/28 ring-teal-900/25',
    badge: 'border-teal-500/45 bg-teal-950/45 text-teal-50',
    bar: 'bg-teal-300/85',
  },
  ok: {
    ring: 'border-emerald-800/45 bg-emerald-950/18 ring-emerald-900/20',
    badge: 'border-emerald-600/45 bg-emerald-950/40 text-emerald-100',
    bar: 'bg-emerald-400/80',
  },
};

function TrailRow(props: { trail: number[] }): ReactElement | null {
  if (!props.trail.length) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1 font-mono text-[10px] tabular-nums">
      <span className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Trail</span>
      {props.trail.map((c, i) => (
        <span key={`${c}-${i}`} className="inline-flex items-center gap-1">
          {i > 0 ? <span className="text-zinc-600">→</span> : null}
          <span className="rounded bg-zinc-800/80 px-1 py-0.5 font-bold text-zinc-200">{c.toFixed(1)}¢</span>
        </span>
      ))}
    </div>
  );
}

export function PositionDeskSignalStrip(props: {
  signal: PositionDeskSignal;
  compact?: boolean;
}): ReactElement {
  const { signal, compact = false } = props;
  const style = STYLE[signal.severity];
  const pressure = signal.exitPressure;
  const momentumUrgent =
    signal.reason === 'momentum_fading' ||
    signal.reason === 'momentum_reversing' ||
    signal.reason === 'momentum_switched' ||
    signal.reason === 'momentum_stall' ||
    signal.reason === 'desk_tp_stall';

  return (
    <div className={`rounded-xl border px-3 py-2.5 ring-1 ${style.ring}`}>
      {momentumUrgent ? (
        <div
          className={`mb-2 rounded-lg border px-2 py-1 text-[10px] font-black uppercase tracking-[0.12em] ${
            signal.severity === 'danger'
              ? 'animate-pulse border-rose-500/50 bg-rose-950/50 text-rose-100'
              : 'border-amber-500/45 bg-amber-950/40 text-amber-50'
          }`}
        >
          {signal.badge} · immediate
        </div>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-500">Desk signal</div>
          <div className="mt-0.5 text-[12px] font-bold leading-snug text-zinc-100">{signal.headline}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {signal.tpHitProbPct != null ? (
            <span
              className={`rounded-lg border px-2 py-1 font-mono text-[10px] font-black tabular-nums ${
                signal.tpHitProbPct >= 55
                  ? 'border-emerald-600/45 bg-emerald-950/40 text-emerald-100'
                  : signal.tpHitProbPct >= 35
                    ? 'border-amber-600/45 bg-amber-950/40 text-amber-50'
                    : 'border-rose-600/45 bg-rose-950/40 text-rose-50'
              }`}
              title="Estimated chance armed TP tags from here"
            >
              TP {signal.tpHitProbPct}%
            </span>
          ) : null}
          <span
            className={`rounded-lg border px-2 py-1 text-[10px] font-black uppercase tracking-wide ${style.badge}`}
          >
            {signal.badge}
          </span>
        </div>
      </div>

      {!compact ? (
        <>
          <div className="mt-2">
            <div className="flex items-center justify-between text-[9px] font-semibold uppercase tracking-wide text-zinc-500">
              <span>Exit pressure</span>
              <span className="font-mono text-zinc-200">{pressure}%</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-900/80">
              <div className={`h-full ${style.bar}`} style={{ width: `${Math.max(4, pressure)}%` }} />
            </div>
          </div>
          <TrailRow trail={signal.midTrailCents} />
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] tabular-nums text-zinc-500">
            {signal.entryCents != null ? (
              <span>
                Entry <span className="font-bold text-zinc-300">{signal.entryCents.toFixed(1)}¢</span>
              </span>
            ) : null}
            {signal.bidCents != null ? (
              <span>
                Bid <span className="font-bold text-zinc-200">{signal.bidCents.toFixed(1)}¢</span>
              </span>
            ) : null}
            {signal.deskTpNowCents != null ? (
              <span>
                Desk TP <span className="font-bold text-violet-200/90">{signal.deskTpNowCents.toFixed(1)}¢</span>
              </span>
            ) : null}
            {signal.deskTpLeadDropCents != null && signal.deskTpLeadDropCents >= 0.5 ? (
              <span className="text-amber-300/90">−{signal.deskTpLeadDropCents.toFixed(1)}¢ TP @ peak</span>
            ) : null}
          </div>
          <p className="mt-1.5 text-[10px] leading-snug text-zinc-400">{signal.detail}</p>
        </>
      ) : (
        <p className="mt-1 text-[10px] leading-snug text-zinc-400">{signal.detail}</p>
      )}
    </div>
  );
}
