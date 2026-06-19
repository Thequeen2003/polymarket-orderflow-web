/**
 * Track how long execution gates have held continuously — required before ENTER fires.
 */

import { evaluateExecutionGates, type ExecutionSignalInput } from './executionSignal';

export type ExecutionConfirmState = {
  proposedLane: 'up' | 'down' | null;
  /** When the current continuous pass streak started. */
  passSinceMs: number | null;
  /** Ms all gates have been true on the current lane. */
  confirmHeldMs: number;
};

const EMPTY: ExecutionConfirmState = {
  proposedLane: null,
  passSinceMs: null,
  confirmHeldMs: 0,
};

/**
 * Advance confirmation timer — reset when lane changes or any gate fails.
 */
export function updateExecutionConfirm(
  prev: ExecutionConfirmState | null,
  input: ExecutionSignalInput,
  nowMs: number,
): ExecutionConfirmState {
  const snap = evaluateExecutionGates(input, nowMs);
  const lane = snap.allGatesPass ? snap.proposedLane : null;

  if (!lane) {
    return { proposedLane: snap.proposedLane, passSinceMs: null, confirmHeldMs: 0 };
  }

  const p = prev ?? EMPTY;
  const sameLane = p.proposedLane === lane && p.passSinceMs != null;

  if (sameLane) {
    const held = Math.max(0, nowMs - p.passSinceMs!);
    return { proposedLane: lane, passSinceMs: p.passSinceMs, confirmHeldMs: held };
  }

  return { proposedLane: lane, passSinceMs: nowMs, confirmHeldMs: 0 };
}
