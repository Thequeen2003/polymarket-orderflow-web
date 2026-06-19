import { describe, expect, it } from 'vitest';
import { computeDeskSpeedSnapshot } from './deskSpeedLayers';
import {
  buildRegimeTpPlan,
  classifyTpRegime,
  evaluateRegimeTpExit,
  REGIME_TIME_STOP_MS,
  resolveRegimeTpPlan,
} from './regimeTpEngine';

describe('classifyTpRegime', () => {
  it('returns CHOP when lane alignment is chop', () => {
    const tEnd = 100_000;
    const desk = computeDeskSpeedSnapshot({
      spotPts: [
        { t: tEnd - 10_000, v: 70_000 },
        { t: tEnd, v: 70_010 },
      ],
      nowSpot: 70_010,
      ptb: 70_100,
      probUpPts: [{ t: tEnd - 10_000, v: 0.5 }, { t: tEnd, v: 0.52 }],
      pMktUp: 0.52,
      probDownPts: [{ t: tEnd - 10_000, v: 0.5 }, { t: tEnd, v: 0.48 }],
      pMktDown: 0.48,
      horizonSec: 10,
    });
    expect(classifyTpRegime({ deskSpeed: desk, lane: 'up', machineRegime: 'chop' })).toBe('CHOP');
  });

  it('returns NEUTRAL when in PTB band', () => {
    expect(classifyTpRegime({ geo: 'IN_BAND', machineRegime: 'grind' })).toBe('NEUTRAL');
  });

  it('returns TREND_GRIND on aligned continuation', () => {
    const tEnd = 100_000;
    const desk = computeDeskSpeedSnapshot({
      spotPts: [
        { t: tEnd - 10_000, v: 70_000 },
        { t: tEnd, v: 70_080 },
      ],
      nowSpot: 70_080,
      ptb: 70_000,
      probUpPts: [{ t: tEnd - 10_000, v: 0.55 }, { t: tEnd, v: 0.62 }],
      pMktUp: 0.62,
      probDownPts: [{ t: tEnd - 10_000, v: 0.45 }, { t: tEnd, v: 0.38 }],
      pMktDown: 0.38,
      horizonSec: 10,
    });
    const regime = classifyTpRegime({
      geo: 'ABOVE',
      deskSpeed: desk,
      lane: 'up',
      machineRegime: 'trend',
    });
    expect(['TREND_GRIND', 'ACCELERATION']).toContain(regime);
  });
});

describe('buildRegimeTpPlan', () => {
  it('uses micro TP in chop', () => {
    const plan = buildRegimeTpPlan('CHOP');
    expect(plan.tpMaxCents).toBeLessThanOrEqual(2);
    expect(plan.maxHoldMs).toBeLessThanOrEqual(15_000);
  });

  it('uses split TP in acceleration', () => {
    const plan = buildRegimeTpPlan('ACCELERATION');
    expect(plan.tp1Cents).toBe(2);
    expect(plan.tp2MaxCents).toBeGreaterThanOrEqual(4);
  });

  it('enables trailing in trend grind', () => {
    const plan = buildRegimeTpPlan('TREND_GRIND');
    expect(plan.tpMinCents).toBeGreaterThanOrEqual(3.5);
    expect(plan.trailing).not.toBeNull();
  });

  it('prefers skip in neutral', () => {
    const plan = buildRegimeTpPlan('NEUTRAL');
    expect(plan.preferSkipTrade).toBe(true);
    expect(plan.tpMaxCents).toBeLessThanOrEqual(1.5);
  });
});

describe('evaluateRegimeTpExit', () => {
  const trendPlan = buildRegimeTpPlan('TREND_GRIND');
  const chopPlan = buildRegimeTpPlan('CHOP');
  const now = 50_000;
  const entry = 0.55;

  it('time-stops stale trades', () => {
    const v = evaluateRegimeTpExit({
      plan: trendPlan,
      entry01: entry,
      current01: 0.552,
      tp01: 0.59,
      entryMs: now - REGIME_TIME_STOP_MS - 1_000,
      nowMs: now,
    });
    expect(v.action).toBe('time_stop');
  });

  it('exits chop on spread stall near entry', () => {
    const v = evaluateRegimeTpExit({
      plan: chopPlan,
      entry01: entry,
      current01: 0.5505,
      tp01: 0.57,
      entryMs: now - 8_000,
      nowMs: now,
      spreadStalled: true,
    });
    expect(v.action).toBe('exit_market');
  });

  it('fires trail exit after giveback from peak', () => {
    const v = evaluateRegimeTpExit({
      plan: trendPlan,
      entry01: entry,
      current01: 0.561,
      tp01: 0.59,
      entryMs: now - 10_000,
      nowMs: now,
      peakGainCents: 4.5,
    });
    expect(v.action).toBe('trail_exit');
  });

  it('takes TP1 on acceleration split', () => {
    const accel = buildRegimeTpPlan('ACCELERATION');
    const v = evaluateRegimeTpExit({
      plan: accel,
      entry01: entry,
      current01: 0.572,
      tp01: 0.6,
      entryMs: now - 5_000,
      nowMs: now,
    });
    expect(v.action).toBe('take_tp1');
  });
});

describe('resolveRegimeTpPlan', () => {
  it('returns a complete plan from inputs', () => {
    const plan = resolveRegimeTpPlan({ geo: 'IN_BAND' });
    expect(plan.regime).toBe('NEUTRAL');
    expect(plan.exitNotes.length).toBeGreaterThan(0);
  });
});
