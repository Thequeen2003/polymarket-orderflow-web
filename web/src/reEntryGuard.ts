/**
 * Lane re-entry / cool-down guard.
 *
 * After an EXIT / STAND_DOWN / FLIP / TRIM, we time-lock the just-vacated lane
 * so the system can't immediately recommend buying back in. This kills the
 * single biggest paper-account killer: oscillating in and out of the same side
 * because momentum looks "good again" 8 seconds later when it's actually noise.
 *
 * Cool-down length depends on how the lane was vacated:
 *   - EXIT / STAND_DOWN  → 25s (a real "abandon" — give it time)
 *   - FLIP               → 15s (legit reversal, can come back if it reverses again)
 *   - TRIM               → 8s  (still partially in; brief pause)
 *
 * Reason-tagged extension (`updateReEntryStateWithReason`):
 *   - NEGATIVE_EDGE     → 35s (model said the trade was −EV; let pricing reset)
 *   - DISCREPANCY_BLOCK → 30s (sensors actively disagreed at exit time)
 *   - WHIPSAW_BAILOUT   → 40s (we left because directive was thrashing; let it settle)
 *   - default           → existing per-action durations
 *
 * Pure module — no React, no globals, every call is deterministic given inputs.
 */

import type { TradeDirective } from './tradeDirective';

const COOLDOWN_AFTER_EXIT_MS = 25_000;
const COOLDOWN_AFTER_FLIP_MS = 15_000;
const COOLDOWN_AFTER_TRIM_MS = 8_000;

const COOLDOWN_FOR_NEGATIVE_EDGE_MS = 35_000;
const COOLDOWN_FOR_DISCREPANCY_MS = 30_000;
const COOLDOWN_FOR_WHIPSAW_MS = 40_000;

export type ReEntryReason = 'NEGATIVE_EDGE' | 'DISCREPANCY_BLOCK' | 'WHIPSAW_BAILOUT' | 'NORMAL';

export type ReEntryState = {
  /** Epoch ms of last UP-side exit-style event, or null. */
  upExitTs: number | null;
  /** Epoch ms of last DOWN-side exit-style event, or null. */
  downExitTs: number | null;
  /** Cool-down duration applied to UP (varies by exit type). */
  upCooldownMs: number;
  /** Cool-down duration applied to DOWN. */
  downCooldownMs: number;
  /** Why each lane is on cool-down (informational; UI shows it in the chip). */
  upReason?: ReEntryReason;
  downReason?: ReEntryReason;
};

export type LaneCooldown = {
  active: boolean;
  msRemaining: number;
};

export type ReEntryStatus = {
  up: LaneCooldown;
  down: LaneCooldown;
  /** Lane currently in active cooldown, or null. If both, picks the longer. */
  laneInCooldown: 'up' | 'down' | null;
  summary: string;
};

export type ReEntryGuardCheck = {
  /** True when the current directive is trying to enter a lane in cool-down. */
  onCooldown: boolean;
  msRemaining: number;
  lane: 'up' | 'down' | null;
  /** Concise human reason. */
  reason: string;
  /** Reason tag (why this lane is locked). */
  reasonTag?: ReEntryReason;
};

const EMPTY: ReEntryState = {
  upExitTs: null,
  downExitTs: null,
  upCooldownMs: 0,
  downCooldownMs: 0,
};

function cooldownForAction(action: TradeDirective['action']): number {
  if (action === 'EXIT' || action === 'STAND_DOWN') return COOLDOWN_AFTER_EXIT_MS;
  if (action === 'FLIP') return COOLDOWN_AFTER_FLIP_MS;
  if (action === 'TRIM') return COOLDOWN_AFTER_TRIM_MS;
  return 0;
}

/**
 * Apply a new directive transition to the cool-down state. Stamp a cool-down on
 * the *previous* lane when the current action is exit-flavored.
 */
export function updateReEntryState(
  prev: ReEntryState | null,
  current: TradeDirective | null,
  previous: TradeDirective | null,
  now: number,
): ReEntryState {
  const base = prev ?? EMPTY;
  if (!current) return base;

  const wasInLane = previous?.lane ?? null;
  if (!wasInLane) return base;

  const cooldownMs = cooldownForAction(current.action);
  if (cooldownMs <= 0) return base;

  if (wasInLane === 'up') {
    return { ...base, upExitTs: now, upCooldownMs: cooldownMs, upReason: 'NORMAL' };
  }
  return { ...base, downExitTs: now, downCooldownMs: cooldownMs, downReason: 'NORMAL' };
}

/**
 * Same as `updateReEntryState` but accepts an explicit reason tag and picks the
 * longer of (action-derived cooldown, reason-derived cooldown). This lets the
 * caller punish "we exited because edge flipped negative" with a longer lockout
 * than a clean trim.
 */
export function updateReEntryStateWithReason(
  prev: ReEntryState | null,
  current: TradeDirective | null,
  previous: TradeDirective | null,
  now: number,
  reason: ReEntryReason,
): ReEntryState {
  const base = prev ?? EMPTY;
  if (!current) return base;
  const wasInLane = previous?.lane ?? null;
  if (!wasInLane) return base;

  const actionCooldown = cooldownForAction(current.action);
  const reasonCooldown =
    reason === 'NEGATIVE_EDGE'
      ? COOLDOWN_FOR_NEGATIVE_EDGE_MS
      : reason === 'DISCREPANCY_BLOCK'
        ? COOLDOWN_FOR_DISCREPANCY_MS
        : reason === 'WHIPSAW_BAILOUT'
          ? COOLDOWN_FOR_WHIPSAW_MS
          : 0;

  const cooldownMs = Math.max(actionCooldown, reasonCooldown);
  if (cooldownMs <= 0) return base;

  if (wasInLane === 'up') {
    return { ...base, upExitTs: now, upCooldownMs: cooldownMs, upReason: reason };
  }
  return { ...base, downExitTs: now, downCooldownMs: cooldownMs, downReason: reason };
}

export function computeReEntryStatus(state: ReEntryState | null, now: number): ReEntryStatus {
  const s = state ?? EMPTY;
  const upRemaining = s.upExitTs != null ? Math.max(0, s.upCooldownMs - (now - s.upExitTs)) : 0;
  const downRemaining = s.downExitTs != null ? Math.max(0, s.downCooldownMs - (now - s.downExitTs)) : 0;
  const up: LaneCooldown = { active: upRemaining > 0, msRemaining: upRemaining };
  const down: LaneCooldown = { active: downRemaining > 0, msRemaining: downRemaining };

  const laneInCooldown: 'up' | 'down' | null =
    up.active && down.active
      ? upRemaining >= downRemaining
        ? 'up'
        : 'down'
      : up.active
        ? 'up'
        : down.active
          ? 'down'
          : null;

  let summary = 'No re-entry cool-down active.';
  if (laneInCooldown) {
    const ms = laneInCooldown === 'up' ? up.msRemaining : down.msRemaining;
    summary = `${laneInCooldown.toUpperCase()} cool-down: ${Math.ceil(ms / 1000)}s remaining — avoid re-entry.`;
  }

  return { up, down, laneInCooldown, summary };
}

/**
 * Is the current directive trying to enter a lane that's in cool-down?
 * Only triggers on actionable entry verbs (INITIATE / ADD / FLIP-into-cooldown-lane).
 */
export function checkReEntry(
  state: ReEntryState | null,
  current: TradeDirective | null,
  now: number,
): ReEntryGuardCheck {
  if (!state || !current?.lane) {
    return { onCooldown: false, msRemaining: 0, lane: null, reason: '' };
  }
  const isEntry = current.action === 'INITIATE' || current.action === 'ADD' || current.action === 'FLIP';
  if (!isEntry) {
    return { onCooldown: false, msRemaining: 0, lane: null, reason: '' };
  }
  const status = computeReEntryStatus(state, now);
  const laneStatus = current.lane === 'up' ? status.up : status.down;
  if (!laneStatus.active) {
    return { onCooldown: false, msRemaining: 0, lane: null, reason: '' };
  }
  const reasonTag: ReEntryReason | undefined = current.lane === 'up' ? state.upReason : state.downReason;
  const reasonSuffix =
    reasonTag === 'NEGATIVE_EDGE'
      ? ' (negative-edge lockout)'
      : reasonTag === 'DISCREPANCY_BLOCK'
        ? ' (sensor-disagreement lockout)'
        : reasonTag === 'WHIPSAW_BAILOUT'
          ? ' (whipsaw lockout)'
          : '';
  return {
    onCooldown: true,
    msRemaining: laneStatus.msRemaining,
    lane: current.lane,
    reason: `${current.lane.toUpperCase()} in cool-down — wait ${Math.ceil(laneStatus.msRemaining / 1000)}s before re-entering${reasonSuffix}.`,
    reasonTag,
  };
}

/**
 * Pick the strongest reason tag for *why* we just left a lane. Caller invokes this
 * when stamping a cooldown so the user sees an honest reason instead of "NORMAL".
 */
export function classifyExitReason(input: {
  whipsaw?: boolean;
  highDiscrepancy?: boolean;
  edgeUsd?: number | null;
}): ReEntryReason {
  if (input.whipsaw) return 'WHIPSAW_BAILOUT';
  if (input.highDiscrepancy) return 'DISCREPANCY_BLOCK';
  if (input.edgeUsd != null && input.edgeUsd < 0) return 'NEGATIVE_EDGE';
  return 'NORMAL';
}
