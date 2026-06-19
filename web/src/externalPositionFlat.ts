/**
 * Detect when an outcome was closed outside this UI (Polymarket / Bullpen app).
 */

import { isOutcomePositionFlat } from './signalsDeskHold';

/** True when exchange balance is zero and sell sizing agrees — safe to disarm brackets. */
export function isExternallyFlatPosition(args: {
  clobBal: number | null | undefined;
  sellShares: number;
}): boolean {
  const { clobBal, sellShares } = args;
  if (clobBal == null || !Number.isFinite(clobBal)) return false;
  if (!isOutcomePositionFlat(clobBal)) return false;
  return isOutcomePositionFlat(sellShares);
}
