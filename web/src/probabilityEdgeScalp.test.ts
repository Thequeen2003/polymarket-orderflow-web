import { describe, expect, it } from 'vitest';
import { estimateBinaryOutcomeBias } from './binaryOutcomeBias';
import {
  EDGE_TRADE_THRESHOLD,
  classifyPtbStretchSetup,
  evaluateProbabilityEdgeScalp,
  momentumAlignsWithEdge,
  marketRepricingIntoEdge,
  scalpSignalFromScore,
} from './probabilityEdgeScalp';

describe('probabilityEdgeScalp', () => {
  it('edge = P_model - P_mkt', () => {
    const tEnd = Date.now();
    const pts = Array.from({ length: 20 }, (_, i) => ({
      t: tEnd - (19 - i) * 2000,
      v: 71_000 + i * 3,
    }));
    const est = estimateBinaryOutcomeBias({
      now: pts[pts.length - 1]!.v,
      ptb: 70_950,
      spotPts: pts,
      pUp01: 0.5,
      slopeUsdPerSec: 0.1,
    })!;
    const scalp = evaluateProbabilityEdgeScalp({
      estimate: est,
      pMkt: 0.945,
      spotPts: pts,
      now: pts[pts.length - 1]!.v,
      ptb: 70_950,
      probUpDelta01: 0.01,
    })!;
    expect(scalp.edge).toBeCloseTo(est.probUp - 0.945, 4);
  });

  it('thresholds raw edge trade at ±3%', () => {
    expect(scalpSignalFromScore(EDGE_TRADE_THRESHOLD * 12 + 0.5, 0.38)).toBe('LONG_UP');
    const mom = momentumAlignsWithEdge(0.05, 1.2);
    expect(mom.ok).toBe(true);
    const bad = momentumAlignsWithEdge(0.05, -1.2);
    expect(bad.ok).toBe(false);
  });

  it('PTB stretch classifies trend vs mean revert', () => {
    const tr = classifyPtbStretchSetup(0.001, 0.05);
    expect(tr.setup).toBe('TREND_LONG');
    const mr = classifyPtbStretchSetup(0.001, -0.05);
    expect(mr.setup).toBe('MEAN_REVERT_SHORT');
  });

  it('repricing requires token move toward model', () => {
    expect(marketRepricingIntoEdge(0.05, 0.01).intoEdge).toBe(true);
    expect(marketRepricingIntoEdge(0.05, -0.01).intoEdge).toBe(false);
    expect(marketRepricingIntoEdge(-0.05, null, 0.01).intoEdge).toBe(true);
    expect(marketRepricingIntoEdge(-0.05, -0.01, 0).intoEdge).toBe(true);
  });
});
