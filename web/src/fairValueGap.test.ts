import { describe, expect, it } from 'vitest';
import {
  appendFairValueGapSample,
  classifyFairValueGapSignal,
  computeFairValueEdgeSides,
  computeFairValueGap,
  computeFairValueGapSignal,
  computeGapZScore,
  rollingMeanRawGap,
  rollingStdRawGap,
  tradeEdgeFromFairValueGap,
} from './fairValueGap';

describe('fairValueGap', () => {
  it('raw gap = expected − actual', () => {
    const r = computeFairValueGap({ pExpected: 0.304, pActual: 0.296 });
    expect(r.rawGap).toBeCloseTo(0.008, 5);
    expect(r.rawGapPp).toBeCloseTo(0.8, 5);
    expect(r.fairValueUp).toBeCloseTo(0.3, 5);
  });

  it('demeans gap and averages fair value against odds', () => {
    const samples = Array.from({ length: 8 }, (_, i) => ({
      t: i,
      pExpected: 0.31,
      pActual: 0.29,
      rawGap: 0.02,
    }));
    const r = computeFairValueGap({ pExpected: 0.34, pActual: 0.296, samples });
    expect(rollingMeanRawGap(samples)).toBeCloseTo(0.02, 5);
    expect(r.meanReady).toBe(true);
    expect(r.gapFromMean).toBeCloseTo(0.024, 5);
    expect(r.fairValueUp).toBeCloseTo((0.296 + 0.34 - 0.02) / 2, 5);
    expect(r.fairEdge).toBeCloseTo(r.gapFromMean / 2, 5);
    expect(tradeEdgeFromFairValueGap(r)).toBeCloseTo(r.gapFromMean / 2, 5);
  });

  it('picks YES when fair above market', () => {
    const s = computeFairValueEdgeSides({ fairUp: 0.304, marketUp: 0.296, yesLabel: 'Up', noLabel: 'Down' });
    expect(s.gapPp).toBeCloseTo(0.8, 5);
    expect(s.favored).toBe('yes');
    expect(s.yesEdgePp).toBeCloseTo(0.8, 5);
    expect(s.noEdgePp).toBeCloseTo(-0.8, 5);
  });

  it('picks NO when fair below market', () => {
    const s = computeFairValueEdgeSides({ fairUp: 0.28, marketUp: 0.32 });
    expect(s.favored).toBe('no');
    expect(s.noEdgePp).toBeGreaterThan(0);
  });

  it('append caps buffer', () => {
    let s = [] as { t: number; pExpected: number; pActual: number; rawGap: number }[];
    for (let i = 0; i < 5; i++) {
      s = appendFairValueGapSample(s, { t: i, pExpected: 0.5, pActual: 0.48, rawGap: 0.02 }, 3);
    }
    expect(s).toHaveLength(3);
  });

  it('z-score normalizes demeaned gap', () => {
    const z = computeGapZScore(0.04, 0.02);
    expect(z).toBeCloseTo(2, 5);
  });

  it('waits for σ when gap history has zero variance', () => {
    const samples = Array.from({ length: 8 }, (_, i) => ({
      t: i,
      pExpected: 0.31,
      pActual: 0.29,
      rawGap: 0.02,
    }));
    const fvg = computeFairValueGap({ pExpected: 0.36, pActual: 0.3, samples });
    const sig = computeFairValueGapSignal({ fvg, samples });
    expect(rollingStdRawGap(samples)).toBeNull();
    expect(sig.zReady).toBe(false);
    expect(sig.signal).toBeNull();
    expect(sig.label).toBe('Warming up');
  });

  it('classifies strong YES when Z×edge > 5', () => {
    expect(classifyFairValueGapSignal(12).tier).toBe('STRONG_YES');
    expect(classifyFairValueGapSignal(12).trade).toBe('BUY_YES');
    expect(classifyFairValueGapSignal(3).tier).toBe('WEAK_YES');
    expect(classifyFairValueGapSignal(0).tier).toBe('NEUTRAL');
    expect(classifyFairValueGapSignal(-3).tier).toBe('WEAK_NO');
    expect(classifyFairValueGapSignal(-8).tier).toBe('STRONG_NO');
  });

  it('computes signal when σ > 0', () => {
    const samples = [
      { t: 0, pExpected: 0.31, pActual: 0.29, rawGap: 0.02 },
      { t: 1, pExpected: 0.33, pActual: 0.29, rawGap: 0.04 },
      { t: 2, pExpected: 0.29, pActual: 0.29, rawGap: 0 },
      { t: 3, pExpected: 0.31, pActual: 0.29, rawGap: 0.02 },
      { t: 4, pExpected: 0.35, pActual: 0.29, rawGap: 0.06 },
      { t: 5, pExpected: 0.31, pActual: 0.29, rawGap: 0.02 },
      { t: 6, pExpected: 0.33, pActual: 0.29, rawGap: 0.04 },
      { t: 7, pExpected: 0.31, pActual: 0.29, rawGap: 0.02 },
    ];
    const fvg = computeFairValueGap({ pExpected: 0.36, pActual: 0.3, samples });
    const sig = computeFairValueGapSignal({ fvg, samples });
    expect(sig.zReady).toBe(true);
    expect(sig.edgePp).toBeCloseTo(6, 5);
    expect(sig.signal).not.toBeNull();
    expect(Math.abs(sig.signal!)).toBeGreaterThan(0);
  });
});
