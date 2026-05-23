import type { ReactElement } from 'react';
import {
  listTakeSignalStrategies,
  type TakeSignalStrategyId,
} from './takeSignalStrategy';

export function TakeSignalStrategyPanel(props: {
  activeIds: TakeSignalStrategyId[];
  onToggle: (id: TakeSignalStrategyId, enabled: boolean) => void;
  /** Shown when strategies block take (from plan.disabledReason). */
  blockHint?: string | null;
}): ReactElement {
  const { activeIds, onToggle, blockHint = null } = props;
  const active = new Set(activeIds);
  const strategies = listTakeSignalStrategies();

  return (
    <div className="mt-2.5 space-y-2 rounded-lg border border-indigo-900/40 bg-indigo-950/15 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wide text-indigo-200/90">Signal strategies</span>
        <span className="text-[9px] text-zinc-500">
          {activeIds.length === 0 ? 'Off — raw card' : `${activeIds.length} active · all must pass`}
        </span>
      </div>
      <p className="text-[10px] leading-snug text-zinc-500">
        Stack filters on <span className="font-semibold text-zinc-400">Take signal</span> and auto-trade. Each checked
        rule must pass before a buy arms.
      </p>
      <ul className="space-y-1.5">
        {strategies.map((s) => {
          const on = active.has(s.id);
          return (
            <li key={s.id}>
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 shrink-0 accent-indigo-500"
                  checked={on}
                  onChange={(e) => onToggle(s.id, e.target.checked)}
                />
                <span className="min-w-0 text-[10px] leading-snug text-zinc-300">
                  <span className={`font-bold ${on ? 'text-indigo-100' : 'text-zinc-400'}`}>{s.label}</span>
                  <span className="text-zinc-500"> — {s.hint}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {blockHint?.trim() ? (
        <p className="text-[10px] leading-snug text-amber-200/90">{blockHint.trim()}</p>
      ) : activeIds.length > 0 ? (
        <p className="text-[10px] leading-snug text-indigo-200/60">Strategies clear — take signal can arm when the card is ready.</p>
      ) : null}
    </div>
  );
}
