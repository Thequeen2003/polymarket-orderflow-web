import { describe, expect, it } from 'vitest';
import { nextTakeProfitState, type TakeProfitTriggerState } from './takeProfit';

const STEP = 0.04; // 4¢

function s(overrides?: Partial<TakeProfitTriggerState>): TakeProfitTriggerState {
  return { prevRef01: null, upStreak: 0, lastBand: 0, ...(overrides ?? {}) };
}

describe('nextTakeProfitState', () => {
  it('does not trigger unless price is continuously rising', () => {
    const momentum01 = 0.5;
    let st = s();

    // Seed prev
    ({ state: st } = nextTakeProfitState({ state: st, ref01: 0.51, momentum01, step01: STEP, minUpStreak: 3 }));
    ({ state: st } = nextTakeProfitState({ state: st, ref01: 0.549, momentum01, step01: STEP, minUpStreak: 3 }));
    // Drop resets streak
    const r3 = nextTakeProfitState({ state: st, ref01: 0.548, momentum01, step01: STEP, minUpStreak: 3 });
    expect(r3.shouldTrigger).toBe(false);
    expect(r3.state.upStreak).toBe(0);
  });

  it('triggers when crossing into the first band above momentum + 4¢ after up-streak', () => {
    const momentum01 = 0.5;
    let st = s();

    // Build streak: 2 consecutive ups.
    ({ state: st } = nextTakeProfitState({ state: st, ref01: 0.51, momentum01, step01: STEP, minUpStreak: 2 }));
    ({ state: st } = nextTakeProfitState({ state: st, ref01: 0.52, momentum01, step01: STEP, minUpStreak: 2 }));
    const r = nextTakeProfitState({ state: st, ref01: 0.54, momentum01, step01: STEP, minUpStreak: 2 });
    expect(r.shouldTrigger).toBe(true);
    expect(r.band).toBe(1);
    expect(r.state.lastBand).toBe(1);
  });

  it('does not re-trigger inside the same band; triggers when entering a higher band', () => {
    const momentum01 = 0.5;
    let st = s({ prevRef01: 0.54, upStreak: 3, lastBand: 1 });

    // Still band 1
    const r1 = nextTakeProfitState({ state: st, ref01: 0.559, momentum01, step01: STEP, minUpStreak: 1 });
    expect(r1.shouldTrigger).toBe(false);
    st = r1.state;

    // Enter band 2 (>= 0.58)
    const r2 = nextTakeProfitState({ state: st, ref01: 0.58, momentum01, step01: STEP, minUpStreak: 1 });
    expect(r2.shouldTrigger).toBe(true);
    expect(r2.band).toBe(2);
  });
});

