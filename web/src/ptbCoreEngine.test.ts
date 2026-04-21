import { describe, expect, it } from 'vitest';
import { buildSpotCandles } from './spotVsPtb';
import { computeTickSlopeUsdPerSec, runPtbCoreEngine, structureEventFromReactionKind } from './ptbCoreEngine';

describe('computeTickSlopeUsdPerSec', () => {
  it('is ~0 for flat prices', () => {
    const t0 = 1_700_000_000_000;
    const ticks = Array.from({ length: 20 }, (_, i) => ({ t: t0 + i * 1000, v: 100 }));
    const s = computeTickSlopeUsdPerSec(ticks);
    expect(Math.abs(s.slopeUsdPerSec)).toBeLessThan(1e-9);
  });

  it('is positive for steady uptrend', () => {
    const t0 = 1_700_000_000_000;
    const ticks = Array.from({ length: 30 }, (_, i) => ({ t: t0 + i * 500, v: 100 + i * 0.1 }));
    const s = computeTickSlopeUsdPerSec(ticks);
    expect(s.slopeUsdPerSec).toBeGreaterThan(0);
    expect(s.slopeUsdPerMin).toBeCloseTo(s.slopeUsdPerSec * 60, 6);
  });
});

describe('structureEventFromReactionKind', () => {
  it('maps chop and reject', () => {
    expect(structureEventFromReactionKind('choppy_at_line')).toBe('chop');
    expect(structureEventFromReactionKind('rejecting_off_line')).toBe('reject');
    expect(structureEventFromReactionKind('break_hold')).toBe('break_and_hold');
    expect(structureEventFromReactionKind('drifting_no_interaction')).toBe('drift');
  });
});

describe('runPtbCoreEngine', () => {
  it('returns dwell + slope + signal for a simple window', () => {
    const ptb = 100;
    const t0 = 1_700_000_000_000;
    const ticks = Array.from({ length: 24 }, (_, i) => ({ t: t0 + i * 800, v: 100.5 + (i % 3) * 0.02 }));
    const candles = buildSpotCandles(ticks, 8);
    const snap = runPtbCoreEngine({ ticks, candles, ptbUsd: ptb });
    expect(snap.derived.position).toBe('ABOVE');
    expect(snap.derived.timeAboveMs + snap.derived.timeBelowMs + snap.derived.timeAtMs).toBeGreaterThan(0);
    expect(snap.structureEvent).toBeTypeOf('string');
    expect(snap.signal.control).toMatch(/UP_CONTROL|DOWN_CONTROL|TRANSITION|REJECTION|NO_EDGE/);
  });
});
