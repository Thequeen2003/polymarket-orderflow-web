import { describe, expect, it } from 'vitest';
import {
  applyTakeSignalStabilityGate,
  directiveAllowsTakeSignal,
  takeSignalPlanMeaningKey,
  TAKE_SIGNAL_MIN_DIRECTIVE_HIGH_MS,
  TAKE_SIGNAL_PLAN_HOLD_MS,
  updateStableTakeSignalPlan,
} from './takeSignalStability';
import type { TakeSignalPlan } from './takeSignalDesk';
import type { TradeDirective } from './tradeDirective';
import type { DirectiveStability } from './directiveStability';

const readyPlan: TakeSignalPlan = {
  canTake: true,
  disabledReason: null,
  lane: 'up',
  entry01: 0.62,
  takeProfit01: 0.65,
  stopLoss01: 0.58,
  buttonLabel: 'Take',
};

describe('takeSignalPlanMeaningKey', () => {
  it('rounds entry to whole cents', () => {
    expect(takeSignalPlanMeaningKey({ ...readyPlan, entry01: 0.621 })).toBe(
      takeSignalPlanMeaningKey({ ...readyPlan, entry01: 0.624 }),
    );
  });
});

describe('updateStableTakeSignalPlan', () => {
  it('holds prior plan until hold window elapses', () => {
    const t0 = 1_000_000;
    let s = updateStableTakeSignalPlan(null, readyPlan, t0);
    const flipped: TakeSignalPlan = { ...readyPlan, canTake: false, lane: null, disabledReason: 'wait' };
    s = updateStableTakeSignalPlan(s, flipped, t0 + 500);
    expect(s.displayed.canTake).toBe(true);
    s = updateStableTakeSignalPlan(s, flipped, t0 + TAKE_SIGNAL_PLAN_HOLD_MS + 1);
    expect(s.displayed.canTake).toBe(false);
  });
});

describe('directiveAllowsTakeSignal', () => {
  it('blocks whipsaw and fresh signals', () => {
    const fresh: DirectiveStability = {
      tier: 'forming',
      msSinceChange: 2_000,
      flipsLastMin: 0,
      current: { ts: 0, action: 'INITIATE', lane: 'up' },
      previous: null,
      history: [],
      warnFresh: true,
      whipsaw: false,
      summary: '',
    };
    expect(directiveAllowsTakeSignal(fresh, null).ok).toBe(false);
    const stable: DirectiveStability = {
      ...fresh,
      tier: 'stable',
      msSinceChange: 20_000,
      warnFresh: false,
    };
    expect(directiveAllowsTakeSignal(stable, null).ok).toBe(true);

    const highInit: TradeDirective = {
      action: 'INITIATE',
      lane: 'up',
      urgency: 'now',
      recommendedSize: 0.4,
      headline: 'INITIATE UP',
      reason: 'r',
      evidence: [],
      confidence: 'HIGH',
      defensive: false,
    };
    const settling: DirectiveStability = { ...fresh, msSinceChange: TAKE_SIGNAL_MIN_DIRECTIVE_HIGH_MS - 500 };
    expect(directiveAllowsTakeSignal(settling, highInit).ok).toBe(false);
    const readyHigh: DirectiveStability = { ...fresh, msSinceChange: TAKE_SIGNAL_MIN_DIRECTIVE_HIGH_MS + 100 };
    expect(directiveAllowsTakeSignal(readyHigh, highInit).ok).toBe(true);
  });
});

describe('applyTakeSignalStabilityGate', () => {
  it('disables canTake when gate fails', () => {
    const out = applyTakeSignalStabilityGate(readyPlan, null);
    expect(out.canTake).toBe(false);
    expect(out.disabledReason).toMatch(/loading/i);
  });
});
