/**
 * Debounce take-signal CTA + require directive to hold before arming take / auto-trade.
 */

import { price01ToWholeCents } from './displayCents';
import type { DirectiveStability } from './directiveStability';
import type { TradeDirective } from './tradeDirective';
import type { TakeSignalPlan } from './takeSignalDesk';

/** Default hold before take / auto-trade (same action + lane on the trade card). */
export const TAKE_SIGNAL_MIN_DIRECTIVE_MS = 3_000;

/** HIGH-confidence INITIATE/ADD can arm sooner — still blocks whipsaw. */
export const TAKE_SIGNAL_MIN_DIRECTIVE_HIGH_MS = 2_000;

/** Rapid-conviction path: HIGH + tape surging/building + was STAND_DOWN → arm very fast. */
export const TAKE_SIGNAL_RAPID_CONVICTION_MS = 1_200;

/** UI plan (lane / canTake / entry) must be unchanged this long before flipping CTA off. */
export const TAKE_SIGNAL_PLAN_HOLD_MS = 2_000;

function isEntryDirective(d: TradeDirective | null | undefined): boolean {
  return d?.action === 'INITIATE' || d?.action === 'ADD' || d?.action === 'FLIP';
}

/** Shorter settle window when the card is a strong fresh entry. */
export function minDirectiveMsForTake(
  stability: DirectiveStability | null,
  directive: TradeDirective | null | undefined,
): number {
  if (stability?.whipsaw) return TAKE_SIGNAL_MIN_DIRECTIVE_MS;
  if (stability?.rapidConviction && directive?.confidence === 'HIGH' && isEntryDirective(directive)) {
    return TAKE_SIGNAL_RAPID_CONVICTION_MS;
  }
  if (directive?.confidence === 'HIGH' && isEntryDirective(directive)) {
    return TAKE_SIGNAL_MIN_DIRECTIVE_HIGH_MS;
  }
  return TAKE_SIGNAL_MIN_DIRECTIVE_MS;
}

export type StableTakeSignalState = {
  displayed: TakeSignalPlan;
  meaningKey: string;
  sinceMs: number;
};

export function takeSignalPlanMeaningKey(plan: TakeSignalPlan): string {
  const entryC = plan.entry01 != null && Number.isFinite(plan.entry01) ? price01ToWholeCents(plan.entry01) : '-';
  return `${plan.canTake ? 1 : 0}|${plan.lane ?? '-'}|${entryC}`;
}

export function updateStableTakeSignalPlan(
  prev: StableTakeSignalState | null,
  live: TakeSignalPlan,
  nowMs: number,
  holdMs = TAKE_SIGNAL_PLAN_HOLD_MS,
): StableTakeSignalState {
  const meaningKey = takeSignalPlanMeaningKey(live);
  if (!prev) return { displayed: live, meaningKey, sinceMs: nowMs };
  if (meaningKey === prev.meaningKey) {
    return { displayed: live, meaningKey, sinceMs: prev.sinceMs };
  }
  if (nowMs - prev.sinceMs < holdMs) {
    return prev;
  }
  return { displayed: live, meaningKey, sinceMs: nowMs };
}

export function directiveAllowsTakeSignal(
  stability: DirectiveStability | null,
  directive: TradeDirective | null | undefined = null,
  minMs?: number,
): { ok: boolean; reason: string | null } {
  const effectiveMin = minMs ?? minDirectiveMsForTake(stability, directive);
  if (!stability?.current) {
    return { ok: false, reason: 'Trade card still loading — wait for a stable ENTER.' };
  }
  if (stability.whipsaw) {
    return {
      ok: false,
      reason: `Signal whipsawing (${stability.flipsLastMin} flips in 60s) — wait for one side to commit.`,
    };
  }
  if (stability.msSinceChange < effectiveMin) {
    const sec = Math.max(1, Math.ceil((effectiveMin - stability.msSinceChange) / 1000));
    const lane = stability.current.lane ? ` ${stability.current.lane.toUpperCase()}` : '';
    return {
      ok: false,
      reason: `Signal settling — ${stability.current.action}${lane} needs ~${sec}s more before take (${Math.round(stability.msSinceChange / 1000)}s held).`,
    };
  }
  return { ok: true, reason: null };
}

/** Apply directive stability gate on top of a (possibly debounced) take plan. */
export function applyTakeSignalStabilityGate(
  plan: TakeSignalPlan,
  stability: DirectiveStability | null,
  directive: TradeDirective | null | undefined = null,
): TakeSignalPlan {
  if (!plan.canTake) return plan;
  const gate = directiveAllowsTakeSignal(stability, directive);
  if (gate.ok) return plan;
  return {
    ...plan,
    canTake: false,
    disabledReason: gate.reason,
    buttonLabel: 'Take signal — settling…',
  };
}
