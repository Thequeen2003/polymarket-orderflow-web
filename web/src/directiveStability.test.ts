import { describe, expect, it } from 'vitest';
import { updateStability } from './directiveStability';
import type { TradeDirective, DirectiveAction } from './tradeDirective';

function mkDirective(action: DirectiveAction, lane: 'up' | 'down' | null = 'up'): TradeDirective {
  return {
    action,
    lane,
    urgency: 'soon',
    recommendedSize: 0.3,
    headline: action,
    reason: 'test',
    evidence: [],
    confidence: 'MED',
    defensive: false,
    edgePerShareUsd: null,
    laneMid: null,
    laneWinProb: null,
  };
}

describe('updateStability', () => {
  it('forms on first snapshot with warnFresh', () => {
    const s = updateStability(null, mkDirective('INITIATE', 'up'), 1000);
    expect(s.tier).toBe('forming');
    expect(s.warnFresh).toBe(true);
    expect(s.history).toHaveLength(1);
  });

  it('stays "forming" within 10s of a fresh change', () => {
    let s = updateStability(null, mkDirective('INITIATE', 'up'), 1000);
    s = updateStability(s, mkDirective('INITIATE', 'up'), 5_000); // same — no change
    expect(s.tier).toBe('forming');
    expect(s.msSinceChange).toBe(4_000);
  });

  it('moves to "consolidating" between 10s and 30s', () => {
    let s = updateStability(null, mkDirective('INITIATE', 'up'), 0);
    s = updateStability(s, mkDirective('INITIATE', 'up'), 15_000);
    expect(s.tier).toBe('consolidating');
    expect(s.msSinceChange).toBe(15_000);
  });

  it('moves to "stable" beyond 30s with no changes', () => {
    let s = updateStability(null, mkDirective('INITIATE', 'up'), 0);
    s = updateStability(s, mkDirective('INITIATE', 'up'), 45_000);
    expect(s.tier).toBe('stable');
    expect(s.msSinceChange).toBe(45_000);
    expect(s.warnFresh).toBe(false);
  });

  it('detects whipsaw when 4+ changes in 60s', () => {
    let s = updateStability(null, mkDirective('INITIATE', 'up'), 0);
    s = updateStability(s, mkDirective('HOLD', 'up'), 5_000);
    s = updateStability(s, mkDirective('TRIM', 'up'), 12_000);
    s = updateStability(s, mkDirective('FLIP', 'down'), 20_000);
    s = updateStability(s, mkDirective('STAND_DOWN', null), 30_000);
    expect(s.flipsLastMin).toBeGreaterThanOrEqual(4);
    expect(s.tier).toBe('whipsaw');
    expect(s.whipsaw).toBe(true);
    expect(s.warnFresh).toBe(true);
  });

  it('records previous and current after a change', () => {
    let s = updateStability(null, mkDirective('INITIATE', 'up'), 0);
    s = updateStability(s, mkDirective('FLIP', 'down'), 12_000);
    expect(s.previous?.action).toBe('INITIATE');
    expect(s.current?.action).toBe('FLIP');
    expect(s.current?.lane).toBe('down');
  });

  it('treats lane changes (same action) as meaningful', () => {
    let s = updateStability(null, mkDirective('INITIATE', 'up'), 0);
    s = updateStability(s, mkDirective('INITIATE', 'down'), 5_000);
    expect(s.previous?.lane).toBe('up');
    expect(s.current?.lane).toBe('down');
    expect(s.msSinceChange).toBe(0);
  });

  it('summary text reflects tier', () => {
    let s = updateStability(null, mkDirective('INITIATE', 'up'), 0);
    expect(s.summary).toMatch(/Fresh|only/i);
    s = updateStability(s, mkDirective('INITIATE', 'up'), 45_000);
    expect(s.summary).toMatch(/stable|held/i);
  });

  it('returns existing prev when directive is null', () => {
    const start = updateStability(null, mkDirective('INITIATE', 'up'), 0);
    const next = updateStability(start, null, 10_000);
    expect(next).toBe(start);
  });

  describe('rapid conviction fast-path', () => {
    function mkHighDirective(action: DirectiveAction, lane: 'up' | 'down' | null = 'up'): TradeDirective {
      return { ...mkDirective(action, lane), confidence: 'HIGH' };
    }

    it('sets rapidConviction=true for HIGH INITIATE after STAND_DOWN', () => {
      let s = updateStability(null, mkDirective('STAND_DOWN', null), 0);
      s = updateStability(s, mkDirective('STAND_DOWN', null), 5_000);
      s = updateStability(s, mkHighDirective('INITIATE', 'up'), 6_000);
      expect(s.rapidConviction).toBe(true);
    });

    it('uses faster forming window (4s not 10s) when rapidConviction', () => {
      let s = updateStability(null, mkDirective('STAND_DOWN', null), 0);
      s = updateStability(s, mkDirective('STAND_DOWN', null), 30_000);
      s = updateStability(s, mkHighDirective('INITIATE', 'down'), 31_000);
      expect(s.rapidConviction).toBe(true);
      expect(s.tier).toBe('forming');
      // After 4.5s it should be consolidating (not still forming for 10s)
      s = updateStability(s, mkHighDirective('INITIATE', 'down'), 35_500);
      expect(s.tier).toBe('consolidating');
    });

    it('warnFresh=false on rapid conviction (immediate trust)', () => {
      let s = updateStability(null, mkDirective('HOLD', 'up'), 0);
      s = updateStability(s, mkDirective('HOLD', 'up'), 30_000);
      s = updateStability(s, mkHighDirective('INITIATE', 'down'), 31_000);
      expect(s.rapidConviction).toBe(true);
      expect(s.warnFresh).toBe(false);
    });

    it('does NOT set rapidConviction for MED confidence', () => {
      let s = updateStability(null, mkDirective('STAND_DOWN', null), 0);
      s = updateStability(s, mkDirective('STAND_DOWN', null), 30_000);
      s = updateStability(s, mkDirective('INITIATE', 'up'), 31_000);
      expect(s.rapidConviction).toBe(false);
    });

    it('does NOT set rapidConviction for HOLD→HOLD (no action change)', () => {
      let s = updateStability(null, mkDirective('HOLD', 'up'), 0);
      s = updateStability(s, mkDirective('HOLD', 'up'), 30_000);
      s = updateStability(s, mkHighDirective('HOLD', 'down'), 31_000);
      expect(s.rapidConviction).toBe(false);
    });
  });
});
