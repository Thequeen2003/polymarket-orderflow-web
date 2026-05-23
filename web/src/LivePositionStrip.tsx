import type { ReactElement } from 'react';

export type BracketStripStatus = 'OFF' | 'ARMED' | 'TRIGGERED';

function bracketAggregate(sl: BracketStripStatus, tp: BracketStripStatus): BracketStripStatus {
  if (sl === 'TRIGGERED' || tp === 'TRIGGERED') return 'TRIGGERED';
  if (sl === 'ARMED' || tp === 'ARMED') return 'ARMED';
  return 'OFF';
}

export function LivePositionStrip(props: {
  outcomeLabel: string;
  lane: 'up' | 'down';
  shares: number;
  maxSellShares: number;
  avgEntry01: number | null;
  pinnedStopCents: string | null;
  pinnedTpCents: string | null;
  stopLossStatus: BracketStripStatus;
  takeProfitStatus: BracketStripStatus;
  bracketLane: 'up' | 'down' | null;
  tabLane: 'up' | 'down';
  compact?: boolean;
}): ReactElement | null {
  const {
    outcomeLabel,
    lane,
    shares,
    maxSellShares,
    avgEntry01,
    pinnedStopCents,
    pinnedTpCents,
    stopLossStatus,
    takeProfitStatus,
    bracketLane,
    tabLane,
    compact = false,
  } = props;

  if (shares <= 0 && maxSellShares <= 0 && bracketAggregate(stopLossStatus, takeProfitStatus) === 'OFF') {
    return null;
  }

  const bracketStatus = bracketAggregate(stopLossStatus, takeProfitStatus);
  const laneMismatch = bracketLane != null && bracketLane !== tabLane;
  const avg =
    avgEntry01 != null && Number.isFinite(avgEntry01) && avgEntry01 > 0 && avgEntry01 < 1
      ? `${(avgEntry01 * 100).toFixed(1)}¢`
      : '—';

  const statusClass =
    bracketStatus === 'TRIGGERED'
      ? 'border-amber-500/50 bg-amber-950/30 text-amber-100'
      : bracketStatus === 'ARMED'
        ? 'border-emerald-700/40 bg-emerald-950/25 text-emerald-100'
        : 'border-zinc-800/60 bg-black/20 text-zinc-400';

  return (
    <div className={compact ? 'mt-2 space-y-1.5' : 'mt-3 space-y-2'}>
      {laneMismatch ? (
        <div className="rounded-lg border border-indigo-500/40 bg-indigo-950/30 px-2.5 py-1.5 text-[10px] leading-snug text-indigo-100">
          Bracket armed on <span className="font-bold uppercase">{bracketLane}</span> — tab is{' '}
          <span className="font-bold uppercase">{tabLane}</span>; exits still watch the held outcome.
        </div>
      ) : null}
      <div className={`rounded-xl border px-3 py-2.5 ${statusClass}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[9px] font-semibold uppercase tracking-[0.14em] opacity-70">
              Position · {lane.toUpperCase()}
            </div>
            <div className="truncate text-sm font-bold">{outcomeLabel}</div>
          </div>
          <span
            className={`rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-wider ${
              bracketStatus === 'TRIGGERED'
                ? 'border-amber-400/50 bg-amber-950/50'
                : bracketStatus === 'ARMED'
                  ? 'border-emerald-500/40 bg-emerald-950/40'
                  : 'border-zinc-700/50 bg-zinc-900/50'
            }`}
          >
            {bracketStatus}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div>
            <div className="text-[9px] uppercase tracking-wide opacity-60">Shares</div>
            <div className="font-mono text-[13px] font-semibold tabular-nums">{shares.toFixed(4)}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wide opacity-60">Max sell</div>
            <div className="font-mono text-[13px] font-semibold tabular-nums">{maxSellShares.toFixed(4)}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wide opacity-60">Avg entry</div>
            <div className="font-mono text-[13px] font-semibold tabular-nums">{avg}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wide opacity-60">Armed SL / TP</div>
            <div className="font-mono text-[13px] font-semibold tabular-nums">
              {pinnedStopCents != null ? `${pinnedStopCents}¢` : '—'} /{' '}
              {pinnedTpCents != null ? `${pinnedTpCents}¢` : '—'}
            </div>
          </div>
        </div>
        <div className="mt-1.5 text-[9px] opacity-60">
          SL {stopLossStatus} · TP {takeProfitStatus}
        </div>
      </div>
    </div>
  );
}