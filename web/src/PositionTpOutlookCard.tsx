import type { ReactElement } from 'react';
import type { PositionTpOutlook } from './positionTpOutlook';

const POSTURE_STYLE: Record<
  PositionTpOutlook['posture'],
  { ring: string; badge: string; bar: string }
> = {
  hold: {
    ring: 'border-emerald-800/45 bg-emerald-950/18 ring-emerald-900/20',
    badge: 'border-emerald-600/45 bg-emerald-950/40 text-emerald-100',
    bar: 'bg-emerald-400/80',
  },
  bank: {
    ring: 'border-amber-800/45 bg-amber-950/18 ring-amber-900/20',
    badge: 'border-amber-600/45 bg-amber-950/40 text-amber-50',
    bar: 'bg-amber-300/85',
  },
  take_profit: {
    ring: 'border-teal-800/45 bg-teal-950/18 ring-teal-900/20',
    badge: 'border-teal-600/45 bg-teal-950/40 text-teal-50',
    bar: 'bg-teal-300/85',
  },
  stop_pushing: {
    ring: 'border-rose-800/45 bg-rose-950/18 ring-rose-900/20',
    badge: 'border-rose-600/45 bg-rose-950/40 text-rose-50',
    bar: 'bg-rose-400/80',
  },
  greedy: {
    ring: 'border-fuchsia-800/45 bg-fuchsia-950/18 ring-fuchsia-900/20',
    badge: 'border-fuchsia-600/45 bg-fuchsia-950/40 text-fuchsia-50',
    bar: 'bg-fuchsia-400/80',
  },
};

export function PositionTpOutlookCard(props: {
  outlook: PositionTpOutlook;
  compact?: boolean;
  variant?: 'held' | 'pre_buy';
}): ReactElement {
  const { outlook, compact = false, variant = 'held' } = props;
  const style = POSTURE_STYLE[outlook.posture];
  const probPct = Math.round(outlook.tpHitProb01 * 100);
  const revPct = Math.round(outlook.reversalRisk01 * 100);
  const progressPct = Math.round(Math.max(0, Math.min(1.15, outlook.progressToTp01)) * 100);

  return (
    <div className={`rounded-xl border px-3 py-3 ring-1 ${style.ring}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-500">
            {variant === 'pre_buy' ? 'Pre-buy TP odds' : 'TP outlook'}
          </div>
          <div className="mt-0.5 text-[12px] font-bold leading-snug text-zinc-100">{outlook.headline}</div>
        </div>
        <span className={`shrink-0 rounded-lg border px-2 py-1 text-[10px] font-black uppercase tracking-wide ${style.badge}`}>
          {outlook.postureLabel}
        </span>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div>
          <div className="flex items-center justify-between text-[9px] font-semibold uppercase tracking-wide text-zinc-500">
            <span>Chance to hit TP</span>
            <span className="font-mono text-zinc-200">{probPct}%</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-zinc-900/70">
            <div className={`h-full ${style.bar}`} style={{ width: `${probPct}%` }} />
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between text-[9px] font-semibold uppercase tracking-wide text-zinc-500">
            <span>Reversal risk</span>
            <span className="font-mono text-zinc-200">{revPct}%</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-zinc-900/70">
            <div
              className={`h-full ${revPct > 65 ? 'bg-rose-400/85' : revPct > 40 ? 'bg-amber-300/80' : 'bg-zinc-500/70'}`}
              style={{ width: `${revPct}%` }}
            />
          </div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums text-zinc-300">
        <span>
          Entry <span className="font-bold text-zinc-100">{outlook.entryCents.toFixed(1)}¢</span>
        </span>
        <span className="text-zinc-600">→</span>
        <span>
          Now <span className="font-bold text-zinc-100">{outlook.currentCents.toFixed(1)}¢</span>
        </span>
        <span className="text-zinc-600">→</span>
        <span>
          TP <span className="font-bold text-emerald-200">{outlook.tpCents.toFixed(1)}¢</span>
        </span>
        <span className="text-zinc-500">
          ({outlook.distanceToTpCents >= 0 ? `${outlook.distanceToTpCents.toFixed(1)}¢ left` : `${Math.abs(outlook.distanceToTpCents).toFixed(1)}¢ past`})
        </span>
      </div>

      {!compact ? (
        <div className="mt-1.5 space-y-1 text-[10px] text-zinc-500">
          <div>
            Path progress {progressPct}% · {outlook.detail}
          </div>
          {outlook.regimePlan ? (
            <div className="font-mono text-[9px] text-zinc-600">
              {outlook.regimePlan.regime.replace('_', ' ')} TP · time stop {outlook.timeStopSec ?? '—'}s
              {outlook.heldSec != null ? ` · held ${outlook.heldSec}s` : ''}
            </div>
          ) : null}
          {outlook.regimeExit && outlook.regimeExit.action !== 'hold' ? (
            <div className="font-semibold text-amber-200/90">{outlook.regimeExit.reason}</div>
          ) : null}
        </div>
      ) : (
        <p className="mt-1.5 text-[10px] leading-snug text-zinc-400">{outlook.detail}</p>
      )}
    </div>
  );
}
