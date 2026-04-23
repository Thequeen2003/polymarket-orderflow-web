import { describe, expect, it } from 'vitest';
import {
  computePtbSettlementCrossProjections,
  estimateDiffusionFromTicks,
  mcCrossProbRefined,
  normalCdf,
} from './ptbProjection';
import type { SpotCandle, SpotTick } from './spotVsPtb';

const minimalCandle: SpotCandle = {
  t0: 0,
  t1: 10_000,
  o: 100,
  h: 101,
  l: 99,
  c: 100.2,
  bodyFrac: 0.3,
  rangeUsd: 2,
};

function risingTicks(n: number, start = 100_000, stepUsdPerS = 2): SpotTick[] {
  const t0 = 1_700_000_000_000;
  const out: SpotTick[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ t: t0 + i * 1000, v: start + (stepUsdPerS * i) / 1 });
  }
  return out;
}

const baseProj = (over: Partial<Parameters<typeof computePtbSettlementCrossProjections>[0]>) => {
  const pts = risingTicks(40, 100_000, 1.5);
  return computePtbSettlementCrossProjections({
    pts,
    candles: [minimalCandle],
    ptb: 100_010,
    s0: pts[pts.length - 1]!.v,
    Tsec: 120,
    slopeUsdPerSec: 0.0008,
    slopeSampleCount: 20,
    controlSignal: 'UP_CONTROL',
    structureEvent: 'drift',
    structureEventLabel: 'Drift — test',
    reactionKind: 'drifting_no_interaction',
    lastProbUp: 0.55,
    lastProbDown: 0.45,
    bookFlow: [],
    mcRandomSeed: 42,
    ...over,
  });
};

describe('ptbProjection', () => {
  it('normalCdf is monotone and bounded', () => {
    expect(normalCdf(-3)).toBeLessThan(normalCdf(0));
    expect(normalCdf(0)).toBeLessThan(normalCdf(2));
    expect(normalCdf(0)).toBeCloseTo(0.5, 5);
    expect(normalCdf(4)).toBeGreaterThan(0.99);
  });

  it('estimateDiffusionFromTicks is non-negative with samples', () => {
    const pts = risingTicks(30);
    const d = estimateDiffusionFromTicks(pts);
    expect(d.n).toBeGreaterThan(0);
    expect(d.sigmaPerSqrtSec).toBeGreaterThan(0);
  });

  it('chop / NO_EDGE compresses toward 50% vs clean drift', () => {
    const clean = baseProj({ structureEvent: 'drift', controlSignal: 'UP_CONTROL' });
    const chop = baseProj({ structureEvent: 'chop', controlSignal: 'NO_EDGE', reactionKind: 'choppy_at_line' });
    expect(clean).not.toBeNull();
    expect(chop).not.toBeNull();
    const dist50clean = Math.abs(clean!.pAboveAtEnd - 0.5);
    const dist50chop = Math.abs(chop!.pAboveAtEnd - 0.5);
    expect(dist50chop).toBeLessThanOrEqual(dist50clean + 0.15);
  });

  it('longer horizon T increases or leaves MC cross prob mostly ordered (fixed seed)', () => {
    const s0 = 100_000;
    const p30 = mcCrossProbRefined({ s0, k: 100_200, mu: 2, sigma: 0.4, horizonSec: 30, paths: 200, randomSeed: 7 });
    const p60 = mcCrossProbRefined({ s0, k: 100_200, mu: 2, sigma: 0.4, horizonSec: 60, paths: 200, randomSeed: 0x1_0007 });
    const p120 = mcCrossProbRefined({ s0, k: 100_200, mu: 2, sigma: 0.4, horizonSec: 120, paths: 200, randomSeed: 0x2_0007 });
    expect(p30).toBeLessThanOrEqual(p60 + 0.12);
    expect(p60).toBeLessThanOrEqual(p120 + 0.12);
  });

  it('larger Tsec affects dispersion (E[close] uses drift × T)', () => {
    const a = baseProj({ Tsec: 60 });
    const b = baseProj({ Tsec: 300 });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.expectedEndPrice).toBeGreaterThan(a!.expectedEndPrice);
  });
});
