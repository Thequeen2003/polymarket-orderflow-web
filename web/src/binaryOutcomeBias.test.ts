import { describe, expect, it } from 'vitest';
import {
  estimateBinaryOutcomeBias,
  impliedSkewS,
  normalizedSpotMomentum,
  ptbDistanceRatio,
  stabilityPressureR,
} from './binaryOutcomeBias';

describe('binaryOutcomeBias', () => {
  it('computes Δ_PTB as fractional distance', () => {
    expect(ptbDistanceRatio(71_100, 71_000)).toBeCloseTo(100 / 71_000, 5);
  });

  it('S = 2*p_up - 1', () => {
    expect(impliedSkewS(0.945)).toBeCloseTo(0.89, 2);
    expect(impliedSkewS(0.5)).toBeCloseTo(0, 5);
  });

  it('stability r uses forward delta in denominator', () => {
    const r = stabilityPressureR(71_100, 71_000, 5, 10);
    expect(r).toBeCloseTo(20, 0);
  });

  it('returns probabilities summing to 1', () => {
    const t0 = Date.now() - 60_000;
    const pts = Array.from({ length: 40 }, (_, i) => ({
      t: t0 + i * 1500,
      v: 71_000 + i * 2.5,
    }));
    const est = estimateBinaryOutcomeBias({
      now: pts[pts.length - 1]!.v,
      ptb: 70_950,
      spotPts: pts,
      pUp01: 0.62,
      slopeUsdPerSec: 0.15,
      bandUsd: 25,
    });
    expect(est).not.toBeNull();
    expect(est!.probUp + est!.probDown).toBeCloseTo(1, 6);
    expect(est!.probUp).toBeGreaterThan(0.5);
    expect(est!.signals.length).toBe(4);
  });

  it('m_norm uses 30s window', () => {
    const tEnd = 1_000_000;
    const pts = [
      { t: tEnd - 45_000, v: 70_050 },
      { t: tEnd - 30_000, v: 70_100 },
      { t: tEnd - 15_000, v: 70_150 },
      { t: tEnd, v: 70_200 },
    ];
    const m = normalizedSpotMomentum(pts, 70_200, 30);
    expect(m.mRaw).toBeCloseTo(100, 0);
    expect(m.mNorm).not.toBeNull();
  });
});
