import { describe, expect, it } from 'vitest';
import {
  buildSettlementBiasDualReadout,
  buildSettlementBiasWarning,
  contractTapeMomentumBounded,
  estimateBinaryOutcomeBias,
  impliedSkewS,
  normalizedSpotMomentum,
  ptbDistanceRatio,
  sideMomentumFromDelta,
  stabilityPressureR,
  type BinaryOutcomeEstimate,
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

  it('flags critical early warning when model diverges from book', () => {
    const estimate = {
      probUp: 0.178,
      probDown: 0.822,
      score: -1.2,
      horizonSec: 300,
      missing: [],
      signals: [],
    } satisfies BinaryOutcomeEstimate;
    const w = buildSettlementBiasWarning({ estimate, marketUp01: 0.05, upLabel: 'Up', downLabel: 'Down' });
    expect(w.level).toBe('critical');
    expect(w.favoredLane).toBe('down');
    expect(w.edgePp).toBeCloseTo(12.8, 1);
    expect(w.headline).toContain('EARLY WARNING');
    expect(w.headline).toContain('Down');
  });

  it('splits finish vs momentum when they disagree', () => {
    const estimate = {
      probUp: 0.178,
      probDown: 0.822,
      score: -0.5,
      horizonSec: 30,
      missing: [],
      signals: [
        {
          id: 'momentumNorm' as const,
          label: 'B) Micro momentum m_norm',
          raw: 4.6,
          bounded: 0.85,
          weight: 1.2,
          contribution: 1.02,
          formula: 'm_norm',
          interpretation: 'up',
        },
      ],
    } satisfies BinaryOutcomeEstimate;
    const dual = buildSettlementBiasDualReadout({ estimate, upLabel: 'Up', downLabel: 'Down' });
    expect(dual.finish.lane).toBe('down');
    expect(dual.finish.probPct).toBeCloseTo(82.2, 1);
    expect(dual.momentum.favoredLane).toBe('up');
    expect(dual.momentum.up.scorePct).toBeGreaterThan(dual.momentum.down.scorePct);
    expect(dual.momentum.up.gaining).toBe(true);
    expect(dual.momentum.active).toBe(true);
    expect(dual.momentum.source).toBe('spot');
    expect(dual.aligned).toBe(false);
    expect(dual.splitNote).toContain('Split');
  });

  it('uses contract tape momentum when spot drift is quiet', () => {
    const estimate = {
      probUp: 0.62,
      probDown: 0.38,
      score: 0.4,
      horizonSec: 30,
      missing: ['Momentum'],
      signals: [],
    } satisfies BinaryOutcomeEstimate;
    const dual = buildSettlementBiasDualReadout({
      estimate,
      upLabel: 'Up',
      downLabel: 'Down',
      probDeltaUp01: 0.018,
      probDeltaDown01: -0.018,
    });
    expect(dual.momentum.active).toBe(true);
    expect(dual.momentum.source).toBe('tape');
    expect(dual.momentum.favoredLane).toBe('up');
    expect(dual.momentum.up.gaining).toBe(true);
    expect(dual.momentum.up.scorePct).toBeGreaterThan(55);
    expect(dual.momentum.down.gaining).toBe(false);
    expect(dual.momentum.down.scorePct).toBeLessThan(45);
  });

  it('shows UP losing when UP contract is falling on tape', () => {
    const estimate = {
      probUp: 0.35,
      probDown: 0.65,
      score: -0.3,
      horizonSec: 30,
      missing: [],
      signals: [
        {
          id: 'momentumNorm' as const,
          label: 'B) Micro momentum m_norm',
          raw: 2.0,
          bounded: 0.85,
          weight: 1.2,
          contribution: 1.02,
          formula: 'm_norm',
          interpretation: 'up',
        },
      ],
    } satisfies BinaryOutcomeEstimate;
    const dual = buildSettlementBiasDualReadout({
      estimate,
      upLabel: 'Up',
      downLabel: 'Down',
      probDeltaUp01: -0.025,
      probDeltaDown01: 0.025,
    });
    expect(dual.momentum.up.scorePct).toBeLessThan(20);
    expect(dual.momentum.up.gaining).toBe(false);
    expect(dual.momentum.down.scorePct).toBeGreaterThan(80);
    expect(dual.momentum.down.gaining).toBe(true);
    expect(dual.momentum.favoredLane).toBe('down');
  });

  it('sideMomentumFromDelta maps falling mid below 50', () => {
    const r = sideMomentumFromDelta(-0.02, 0.85);
    expect(r.gaining).toBe(false);
    expect(r.scorePct).toBeLessThan(15);
    expect(r.source).toBe('tape');
  });

  it('stays quiet when neither spot nor tape is moving', () => {
    const estimate = {
      probUp: 0.62,
      probDown: 0.38,
      score: 0.4,
      horizonSec: 30,
      missing: [],
      signals: [
        {
          id: 'momentumNorm' as const,
          label: 'B) Micro momentum m_norm',
          raw: 0.02,
          bounded: 0.01,
          weight: 1.2,
          contribution: 0.012,
          formula: 'm_norm',
          interpretation: 'flat',
        },
      ],
    } satisfies BinaryOutcomeEstimate;
    const dual = buildSettlementBiasDualReadout({
      estimate,
      probDeltaUp01: 0.0001,
      probDeltaDown01: -0.0001,
    });
    expect(dual.momentum.active).toBe(false);
    expect(dual.momentum.favoredLane).toBe('flat');
    expect(dual.momentum.up.scorePct).toBe(50);
  });

  it('maps contract tape delta to bounded push', () => {
    expect(contractTapeMomentumBounded(0.02, -0.02)).toBeGreaterThan(0.7);
    expect(contractTapeMomentumBounded(-0.02, 0.02)).toBeLessThan(-0.7);
    expect(contractTapeMomentumBounded(null, null)).toBeNull();
    expect(contractTapeMomentumBounded(0.0001, -0.0001)).toBe(0);
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
