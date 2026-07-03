import type { ReactElement } from 'react';
import type { EntryMoment, EntryMomentPhase } from './entryMoment';

function phaseStyles(phase: EntryMomentPhase): {
  border: string;
  bg: string;
  headline: string;
  bar: string;
} {
  switch (phase) {
    case 'ENTER_NOW':
      return {
        border: 'border-emerald-500/55',
        bg: 'bg-emerald-950/40',
        headline: 'text-emerald-100',
        bar: 'bg-emerald-400',
      };
    case 'CONFIRMING':
      return {
        border: 'border-amber-500/50',
        bg: 'bg-amber-950/35',
        headline: 'text-amber-100',
        bar: 'bg-amber-400',
      };
    case 'ALERT':
      return {
        border: 'border-indigo-500/45',
        bg: 'bg-indigo-950/30',
        headline: 'text-indigo-100',
        bar: 'bg-indigo-400',
      };
    case 'WAIT_PULLBACK':
      return {
        border: 'border-orange-500/45',
        bg: 'bg-orange-950/25',
        headline: 'text-orange-100',
        bar: 'bg-orange-400',
      };
    case 'NO_TRADE':
      return {
        border: 'border-zinc-600/50',
        bg: 'bg-zinc-950/50',
        headline: 'text-zinc-400',
        bar: 'bg-zinc-500',
      };
    default:
      return {
        border: 'border-zinc-700/50',
        bg: 'bg-zinc-950/35',
        headline: 'text-zinc-300',
        bar: 'bg-zinc-500',
      };
  }
}

export function EntryMomentStrip(props: {
  moment: EntryMoment;
  compact?: boolean;
  showChecks?: boolean;
}): ReactElement {
  const { moment, compact = false, showChecks = !compact } = props;
  const styles = phaseStyles(moment.phase);
  const pulse = moment.phase === 'ENTER_NOW' ? 'animate-pulse' : '';

  return (
    <div
      className={`rounded-xl border-2 ${styles.border} ${styles.bg} px-3 py-2.5 shadow-sm shadow-black/20 ${pulse}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`text-sm font-black uppercase tracking-wide ${styles.headline}`}>
          {moment.headline}
        </span>
        <div className="flex items-center gap-2">
          {moment.confirmSecRemaining != null && moment.confirmSecRemaining > 0 ? (
            <span className="rounded-md border border-amber-600/40 bg-amber-950/50 px-1.5 py-0.5 font-mono text-[10px] font-bold tabular-nums text-amber-200">
              {moment.confirmSecRemaining}s
            </span>
          ) : null}
          <span className="font-mono text-[10px] font-semibold tabular-nums text-zinc-400">
            {moment.readinessPct}% ready
          </span>
        </div>
      </div>

      <p className={`mt-1.5 leading-snug text-zinc-200 ${compact ? 'text-[10px]' : 'text-[11px]'}`}>
        {moment.exactAction}
      </p>

      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-900/70">
        <div
          className={`h-full transition-all duration-500 ${styles.bar}`}
          style={{ width: `${Math.max(4, moment.readinessPct)}%` }}
        />
      </div>

      {showChecks && moment.checks.length > 0 ? (
        <ul className="mt-2.5 space-y-1 border-t border-white/10 pt-2">
          {moment.checks.map((c) => (
            <li key={c.id} className="flex items-start gap-2 text-[10px] leading-snug">
              <span className={`mt-px shrink-0 font-bold ${c.pass ? 'text-emerald-400' : 'text-zinc-500'}`}>
                {c.pass ? '✓' : '○'}
              </span>
              <span className="min-w-0">
                <span className="font-semibold text-zinc-300">{c.label}</span>
                <span className="text-zinc-500"> — </span>
                <span className="text-zinc-400">{c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
