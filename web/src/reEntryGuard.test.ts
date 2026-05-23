import { describe, expect, it } from 'vitest';
import {
  updateReEntryState,
  updateReEntryStateWithReason,
  computeReEntryStatus,
  checkReEntry,
  classifyExitReason,
} from './reEntryGuard';
import type { TradeDirective, DirectiveAction } from './tradeDirective';

function mkD(action: DirectiveAction, lane: 'up' | 'down' | null = null): TradeDirective {
  return {
    action,
    lane,
    urgency: 'soon',
    recommendedSize: 0.3,
    headline: action,
    reason: '',
    evidence: [],
    confidence: 'MED',
    defensive: false,
    edgePerShareUsd: null,
    laneMid: null,
    laneWinProb: null,
  };
}

describe('reEntryGuard', () => {
  it('no exit produces no cooldown', () => {
    const prev = mkD('INITIATE', 'up');
    const curr = mkD('HOLD', 'up');
    const state = updateReEntryState(null, curr, prev, 1000);
    const status = computeReEntryStatus(state, 2000);
    expect(status.laneInCooldown).toBeNull();
    expect(status.up.active).toBe(false);
  });

  it('EXIT stamps 25s cool-down on the previously held lane', () => {
    const prev = mkD('INITIATE', 'up');
    const curr = mkD('EXIT', null);
    const state = updateReEntryState(null, curr, prev, 0);
    const status = computeReEntryStatus(state, 5_000);
    expect(state.upCooldownMs).toBe(25_000);
    expect(status.up.active).toBe(true);
    expect(status.up.msRemaining).toBeGreaterThan(15_000);
    expect(status.laneInCooldown).toBe('up');
  });

  it('STAND_DOWN behaves like EXIT', () => {
    const state = updateReEntryState(
      null,
      mkD('STAND_DOWN', null),
      mkD('INITIATE', 'down'),
      0,
    );
    expect(state.downCooldownMs).toBe(25_000);
    expect(state.downExitTs).toBe(0);
  });

  it('FLIP uses a shorter 15s cool-down', () => {
    const state = updateReEntryState(
      null,
      mkD('FLIP', 'down'),
      mkD('INITIATE', 'up'),
      0,
    );
    expect(state.upCooldownMs).toBe(15_000);
  });

  it('TRIM uses an even shorter 8s cool-down', () => {
    const state = updateReEntryState(
      null,
      mkD('TRIM', 'up'),
      mkD('INITIATE', 'up'),
      0,
    );
    expect(state.upCooldownMs).toBe(8_000);
  });

  it('cool-down expires after the configured duration', () => {
    const state = updateReEntryState(null, mkD('EXIT', null), mkD('INITIATE', 'up'), 0);
    const status = computeReEntryStatus(state, 30_000);
    expect(status.up.active).toBe(false);
    expect(status.laneInCooldown).toBeNull();
  });

  it('checkReEntry blocks INITIATE on the cooled-down lane', () => {
    const state = updateReEntryState(null, mkD('EXIT', null), mkD('INITIATE', 'up'), 0);
    const guard = checkReEntry(state, mkD('INITIATE', 'up'), 5_000);
    expect(guard.onCooldown).toBe(true);
    expect(guard.lane).toBe('up');
    expect(guard.msRemaining).toBeGreaterThan(15_000);
    expect(guard.reason).toMatch(/UP/);
  });

  it('checkReEntry permits entry on the opposite lane', () => {
    const state = updateReEntryState(null, mkD('EXIT', null), mkD('INITIATE', 'up'), 0);
    const guard = checkReEntry(state, mkD('INITIATE', 'down'), 5_000);
    expect(guard.onCooldown).toBe(false);
  });

  it('checkReEntry ignores non-entry actions (HOLD/EXIT)', () => {
    const state = updateReEntryState(null, mkD('EXIT', null), mkD('INITIATE', 'up'), 0);
    expect(checkReEntry(state, mkD('HOLD', 'up'), 5_000).onCooldown).toBe(false);
    expect(checkReEntry(state, mkD('EXIT', null), 5_000).onCooldown).toBe(false);
  });

  it('summary reads naturally', () => {
    const state = updateReEntryState(null, mkD('EXIT', null), mkD('INITIATE', 'up'), 0);
    const status = computeReEntryStatus(state, 10_000);
    expect(status.summary).toMatch(/UP cool-down/);
    expect(status.summary).toMatch(/\d+s/);
  });

  it('handles concurrent cooldowns on both lanes', () => {
    let s = updateReEntryState(null, mkD('EXIT', null), mkD('INITIATE', 'up'), 0);
    s = updateReEntryState(s, mkD('EXIT', null), mkD('INITIATE', 'down'), 5_000);
    const status = computeReEntryStatus(s, 6_000);
    expect(status.up.active).toBe(true);
    expect(status.down.active).toBe(true);
    // Whichever has more time remaining wins the "in cooldown" label.
    expect(status.laneInCooldown).toBe('down');
  });
});

describe('updateReEntryStateWithReason', () => {
  it('NEGATIVE_EDGE picks the longer lockout (35s)', () => {
    const state = updateReEntryStateWithReason(
      null,
      mkD('EXIT', null),
      mkD('INITIATE', 'up'),
      0,
      'NEGATIVE_EDGE',
    );
    expect(state.upCooldownMs).toBe(35_000);
    expect(state.upReason).toBe('NEGATIVE_EDGE');
  });

  it('WHIPSAW_BAILOUT picks 40s lockout', () => {
    const state = updateReEntryStateWithReason(
      null,
      mkD('STAND_DOWN', null),
      mkD('INITIATE', 'down'),
      0,
      'WHIPSAW_BAILOUT',
    );
    expect(state.downCooldownMs).toBe(40_000);
    expect(state.downReason).toBe('WHIPSAW_BAILOUT');
  });

  it('NORMAL reason falls back to the action duration', () => {
    const state = updateReEntryStateWithReason(
      null,
      mkD('TRIM', 'up'),
      mkD('INITIATE', 'up'),
      0,
      'NORMAL',
    );
    expect(state.upCooldownMs).toBe(8_000);
  });

  it('checkReEntry exposes reasonTag in the chip text', () => {
    const state = updateReEntryStateWithReason(
      null,
      mkD('EXIT', null),
      mkD('INITIATE', 'up'),
      0,
      'NEGATIVE_EDGE',
    );
    const guard = checkReEntry(state, mkD('INITIATE', 'up'), 5_000);
    expect(guard.reasonTag).toBe('NEGATIVE_EDGE');
    expect(guard.reason).toMatch(/negative-edge lockout/i);
  });
});

describe('classifyExitReason', () => {
  it('whipsaw beats other reasons', () => {
    expect(classifyExitReason({ whipsaw: true, highDiscrepancy: true, edgeUsd: -0.1 })).toBe(
      'WHIPSAW_BAILOUT',
    );
  });

  it('discrepancy beats negative edge', () => {
    expect(classifyExitReason({ highDiscrepancy: true, edgeUsd: -0.1 })).toBe('DISCREPANCY_BLOCK');
  });

  it('negative edge picked when others quiet', () => {
    expect(classifyExitReason({ edgeUsd: -0.05 })).toBe('NEGATIVE_EDGE');
  });

  it('returns NORMAL when nothing notable', () => {
    expect(classifyExitReason({})).toBe('NORMAL');
    expect(classifyExitReason({ edgeUsd: 0.1 })).toBe('NORMAL');
  });
});
