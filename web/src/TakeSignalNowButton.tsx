import type { ReactElement } from 'react';
import type { TakeSignalPlan } from './takeSignalDesk';

export function TakeSignalNowButton(props: {
  plan: TakeSignalPlan;
  sizeShares: number;
  onTake: () => void;
  compact?: boolean;
  /** Plain settlement / bracket physics under the button when armed. */
  physicsHint?: string | null;
}): ReactElement {
  const { plan, sizeShares, onTake, compact = false, physicsHint = null } = props;
  const disabled = !plan.canTake || !(Number.isFinite(sizeShares) && sizeShares > 0);
  const shLabel = Number.isFinite(sizeShares) && sizeShares > 0 ? sizeShares : '—';
  const laneLabel = plan.lane === 'up' ? 'UP' : plan.lane === 'down' ? 'DOWN' : '—';
  return (
    <div className={compact ? 'mt-2' : 'mt-3'}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (!plan.canTake) return;
          onTake();
        }}
        title={
          disabled
            ? plan.disabledReason ?? undefined
            : `Limit buy ${shLabel} sh ${laneLabel} at card entry (no auto SL/TP from take signal)`
        }
        className={`w-full min-h-[48px] rounded-xl border px-4 py-3 text-center font-black uppercase tracking-wide transition-all ${
          disabled
            ? 'cursor-not-allowed border-zinc-700/50 bg-zinc-900/40 text-zinc-500'
            : 'border-emerald-400/70 bg-gradient-to-b from-emerald-500/25 to-emerald-950/50 text-emerald-50 shadow-lg shadow-emerald-950/40 hover:border-emerald-300/80 hover:from-emerald-500/35 active:scale-[0.99]'
        } ${compact ? 'text-[11px]' : 'text-xs sm:text-sm'}`}
      >
        {disabled ? plan.buttonLabel : `${plan.buttonLabel} · ${shLabel} sh · ${laneLabel}`}
      </button>
      {disabled && plan.disabledReason ? (
        <p className="mt-1.5 text-center text-[10px] leading-snug text-zinc-500">{plan.disabledReason}</p>
      ) : disabled && !plan.disabledReason ? (
        <p className="mt-1.5 text-center text-[10px] leading-snug text-zinc-500">Enter a valid share size above.</p>
      ) : !disabled ? (
        <p className="mt-1.5 text-center text-[10px] leading-snug text-emerald-200/70">
          {physicsHint?.trim() ? (
            physicsHint.trim()
          ) : (
            <>
              {plan.lane ? `${laneLabel} limit buy · ` : ''}
              entry only — arm SL/TP yourself in Brackets · tags I hold after shares land
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}

