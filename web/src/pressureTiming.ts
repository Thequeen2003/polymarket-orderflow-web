/**
 * Detect whether pressure is early (buildup) vs late (chasing an already-repriced move).
 */

import type { DeskSpeedSnapshot } from './deskSpeedLayers';
import type { ContractEntryJump } from './deskSpeedGainPct';

/** Primary pressure window — react here, not on 30s confirm. */
export const PRESSURE_EARLY_HORIZON_SEC = 10;
/** Confirm / extension check — how far the move already ran. */
export const PRESSURE_CONFIRM_HORIZON_SEC = 30;

/** Max prob ¢ move on early window to count as “building”, not “already jumped”. */
export const PRESSURE_EARLY_MAX_PROB_PP = 7;
/** Confirm window: move beyond this = extended. */
export const PRESSURE_EXTENDED_PROB_PP = 14;
export const PRESSURE_EXTENDED_GAIN_PCT = 18;
/** Confirm window: move beyond this = chasing — do not treat as fresh setup. */
export const PRESSURE_CHASING_PROB_PP = 22;
export const PRESSURE_CHASING_GAIN_PCT = 30;

export type PressureTiming = 'EARLY' | 'BUILDING' | 'EXTENDED' | 'CHASING';

export type PressureTimingReadout = {
  timing: PressureTiming;
  confirmProbPp: number;
  confirmGainPct: number | null;
  note: string;
  /** Cap bullish verdict when timing is late. */
  maxVerdict: 'STRONG_SETUP' | 'EARLY_ENTRY' | 'WATCH' | 'NO_TRADE';
};

export function activeConfirmProbPp(
  confirm: DeskSpeedSnapshot,
  bias: 'BUY' | 'SELL',
): number {
  const prob = bias === 'BUY' ? confirm.lanes.up.prob : confirm.lanes.down.prob;
  if (!prob) return 0;
  return Math.abs(prob.delta30) * 100;
}

export function classifyPressureTiming(params: {
  confirm: DeskSpeedSnapshot;
  bias: 'BUY' | 'SELL' | 'NEUTRAL';
  entryJump: ContractEntryJump | null;
}): PressureTimingReadout {
  const { confirm, bias, entryJump } = params;
  if (bias === 'NEUTRAL') {
    return {
      timing: 'EARLY',
      confirmProbPp: 0,
      confirmGainPct: null,
      note: 'No clear side — watch early 10s tape.',
      maxVerdict: 'NO_TRADE',
    };
  }

  const confirmProbPp = activeConfirmProbPp(confirm, bias);
  const confirmGainPct = entryJump ? Math.abs(entryJump.gainPct) : null;

  const chasing =
    confirmProbPp >= PRESSURE_CHASING_PROB_PP ||
    (confirmGainPct != null && confirmGainPct >= PRESSURE_CHASING_GAIN_PCT);
  const extended =
    !chasing &&
    (confirmProbPp >= PRESSURE_EXTENDED_PROB_PP ||
      (confirmGainPct != null && confirmGainPct >= PRESSURE_EXTENDED_GAIN_PCT));
  const building =
    !chasing &&
    !extended &&
    (confirmProbPp >= 5 || (confirmGainPct != null && confirmGainPct >= 8));

  if (chasing) {
    return {
      timing: 'CHASING',
      confirmProbPp,
      confirmGainPct,
      note: `Move already +${confirmProbPp.toFixed(0)}pp${confirmGainPct != null ? ` (+${confirmGainPct.toFixed(0)}%)` : ''} on ${confirm.horizonSec}s — confirming late, not early entry.`,
      maxVerdict: 'WATCH',
    };
  }
  if (extended) {
    return {
      timing: 'EXTENDED',
      confirmProbPp,
      confirmGainPct,
      note: `Repricing mostly done (+${confirmProbPp.toFixed(0)}pp / ${confirm.horizonSec}s) — add only on pullback.`,
      maxVerdict: 'EARLY_ENTRY',
    };
  }
  if (building) {
    return {
      timing: 'BUILDING',
      confirmProbPp,
      confirmGainPct,
      note: `Move underway (+${confirmProbPp.toFixed(0)}pp / ${confirm.horizonSec}s) — act on 10s lead, not 30s confirm.`,
      maxVerdict: 'STRONG_SETUP',
    };
  }
  return {
    timing: 'EARLY',
    confirmProbPp,
    confirmGainPct,
    note: `Fresh buildup on ${confirm.horizonSec}s (< ${PRESSURE_EXTENDED_PROB_PP}pp) — ideal early window.`,
    maxVerdict: 'STRONG_SETUP',
  };
}

export function probPressurePointEarly(
  prob: { direction: string; delta30: number } | null | undefined,
  wantDirection: 'UP' | 'DOWN',
): boolean {
  if (!prob || prob.direction !== wantDirection) return false;
  return Math.abs(prob.delta30) * 100 <= PRESSURE_EARLY_MAX_PROB_PP;
}

export function spotLedLeadNote(
  early: DeskSpeedSnapshot,
  bias: 'BUY' | 'SELL',
  upLabel: string,
  downLabel: string,
): string | null {
  const spotOk =
    bias === 'BUY' ? early.spot?.direction === 'UP' : early.spot?.direction === 'DOWN';
  if (!spotOk) return null;
  const prob =
    bias === 'BUY' ? early.lanes.up.prob : early.lanes.down.prob;
  const probPp = prob ? Math.abs(prob.delta30) * 100 : 999;
  if (probPp > 4) return null;
  const label = bias === 'BUY' ? upLabel : downLabel;
  return `Lead · spot/PTB moving before ${label} mid (+${probPp.toFixed(1)}pp on ${early.horizonSec}s) — early entry zone.`;
}
