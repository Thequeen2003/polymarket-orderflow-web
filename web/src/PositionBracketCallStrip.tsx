import type { ReactElement } from 'react';
import type { PositionBracketCall } from './positionBracketCall';

const SHELL: Record<
  PositionBracketCall['severity'],
  { ring: string; badge: string; label: string }
> = {
  danger: {
    ring: 'border-rose-600/55 bg-rose-950/35 ring-rose-900/30',
    badge: 'border-rose-500/50 bg-rose-950/50 text-rose-50',
    label: 'Sell now',
  },
  warn: {
    ring: 'border-amber-600/50 bg-amber-950/28 ring-amber-900/25',
    badge: 'border-amber-500/45 bg-amber-950/45 text-amber-50',
    label: 'Watch SL',
  },
  profit: {
    ring: 'border-teal-600/50 bg-teal-950/28 ring-teal-900/25',
    badge: 'border-teal-500/45 bg-teal-950/45 text-teal-50',
    label: 'Take profit',
  },
  ok: {
    ring: 'border-emerald-800/45 bg-emerald-950/18 ring-emerald-900/20',
    badge: 'border-emerald-600/45 bg-emerald-950/40 text-emerald-100',
    label: 'Hold',
  },
};

export function PositionBracketCallStrip(props: {
  call: PositionBracketCall;
  compact?: boolean;
}): ReactElement {
  const { call, compact = false } = props;
  const style = SHELL[call.severity];

  return (
    <div className={`rounded-xl border px-3 py-2.5 ring-1 ${style.ring}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-500">TP / SL call</div>
          <div className="mt-0.5 text-[12px] font-bold leading-snug text-zinc-100">{call.headline}</div>
        </div>
        <span
          className={`shrink-0 rounded-lg border px-2 py-1 text-[10px] font-black uppercase tracking-wide ${style.badge}`}
        >
          {style.label}
        </span>
      </div>
      {!compact ? (
        <>
          <p className="mt-1.5 text-[10px] leading-snug text-zinc-400">{call.detail}</p>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] tabular-nums text-zinc-500">
            <span>
              Entry <span className="font-bold text-zinc-300">{call.entryCents.toFixed(1)}¢</span>
            </span>
            {call.armedTpCents != null ? (
              <span>
                TP <span className="font-bold text-emerald-200/90">{call.armedTpCents.toFixed(1)}¢</span>
              </span>
            ) : null}
            {call.liveDeskTpCents != null ? (
              <span>
                Desk TP <span className="font-bold text-violet-200/90">{call.liveDeskTpCents.toFixed(1)}¢</span>
              </span>
            ) : null}
            {call.armedSlCents != null ? (
              <span>
                SL <span className="font-bold text-rose-200/90">{call.armedSlCents.toFixed(1)}¢</span>
              </span>
            ) : null}
            {call.bidCents != null ? (
              <span>
                Bid <span className="font-bold text-zinc-200">{call.bidCents.toFixed(1)}¢</span>
              </span>
            ) : null}
          </div>
        </>
      ) : (
        <p className="mt-1 text-[10px] leading-snug text-zinc-400">{call.detail}</p>
      )}
    </div>
  );
}
