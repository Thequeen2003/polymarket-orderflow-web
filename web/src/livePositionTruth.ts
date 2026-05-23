/**
 * Single live outcome share count for HUD, sell box, and bracket sizing.
 */

import { floorShares4 } from './tradingRound';

/** CLOB balance lag after a buy — sell / max use history until this window ends. */
export const LIVE_BUY_FILL_GRACE_MS = 12_000;

export type LiveSharesPolicy = 'display' | 'sell';

export type ResolveLiveOutcomeSharesInput = {
  clobBal: number | null | undefined;
  bullpenShares: number | null | undefined;
  historyEst: number;
  policy: LiveSharesPolicy;
  /** Ms since last confirmed buy on this token — enables optimistic sizing before CLOB catches up. */
  msSinceBuyFill?: number | null;
};

function normShares(n: number | null | undefined): number {
  if (n == null || !Number.isFinite(n) || n <= 0) return 0;
  return floorShares4(n);
}

/** Authoritative shares for one outcome token. */
export function resolveLiveOutcomeShares(input: ResolveLiveOutcomeSharesInput): number {
  const clob = normShares(input.clobBal);
  const bullpen = normShares(input.bullpenShares);
  const hist = input.historyEst > 0 ? floorShares4(input.historyEst) : 0;

  if (input.policy === 'sell') {
    if (clob > 0) return clob;
    const grace =
      input.msSinceBuyFill != null &&
      Number.isFinite(input.msSinceBuyFill) &&
      input.msSinceBuyFill >= 0 &&
      input.msSinceBuyFill <= LIVE_BUY_FILL_GRACE_MS;
    if (grace) return Math.max(bullpen, hist);
    return 0;
  }

  return Math.max(clob, bullpen, hist);
}

export function resolveLiveLaneShares(input: {
  lane: 'up' | 'down';
  balUp: number | null | undefined;
  balDown: number | null | undefined;
  posSharesUp: number | null | undefined;
  posSharesDown: number | null | undefined;
  estSharesUp: number;
  estSharesDown: number;
  policy: LiveSharesPolicy;
  msSinceBuyFillUp?: number | null;
  msSinceBuyFillDown?: number | null;
}): number {
  const isUp = input.lane === 'up';
  return resolveLiveOutcomeShares({
    clobBal: isUp ? input.balUp : input.balDown,
    bullpenShares: isUp ? input.posSharesUp : input.posSharesDown,
    historyEst: isUp ? input.estSharesUp : input.estSharesDown,
    policy: input.policy,
    msSinceBuyFill: isUp ? input.msSinceBuyFillUp : input.msSinceBuyFillDown,
  });
}
