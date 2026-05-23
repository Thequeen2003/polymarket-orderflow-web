import { describe, expect, it } from 'vitest';
import {
  estimateEndingProbability,
  estimatePtbCrossProbability,
  estimateSpotDrift,
  estimateSpotVolatility,
  type Tick,
} from './ptbCrossProbability';

function genLine(start: number, durMs: number, dollarsPerSec: number, stepMs = 1000): Tick[] {
  const out: Tick[] = [];
  for (let t = 0; t <= durMs; t += stepMs) {
    out.push({ t: start + t, v: 100 + dollarsPerSec * (t / 1000) });
  }
  return out;
}

describe('estimateSpotDrift', () => {
  it('recovers the slope of a clean line', () => {
    const ticks = genLine(0, 60_000, 0.5); // +$0.5 per second
    const m = estimateSpotDrift(ticks, 60_000);
    expect(m).toBeGreaterThan(0.45);
    expect(m).toBeLessThan(0.55);
  });

  it('returns 0 for flat ticks', () => {
    const ticks = genLine(0, 60_000, 0);
    const m = estimateSpotDrift(ticks, 60_000);
    expect(Math.abs(m)).toBeLessThan(1e-6);
  });

  it('returns 0 with insufficient data', () => {
    expect(estimateSpotDrift([], 60_000)).toBe(0);
    expect(estimateSpotDrift([{ t: 0, v: 100 }], 60_000)).toBe(0);
  });
});

describe('estimateSpotVolatility', () => {
  it('returns a meaningful sigma for jittery data', () => {
    const ticks: Tick[] = [];
    for (let i = 0; i < 60; i++) ticks.push({ t: i * 1000, v: 100 + (i % 2 ? 1 : -1) });
    const sigma = estimateSpotVolatility(ticks, 60_000, 0.5);
    expect(sigma).toBeGreaterThan(0.5);
  });

  it('falls back to band when too few samples', () => {
    const sigma = estimateSpotVolatility([{ t: 0, v: 100 }], 60_000, 4);
    expect(sigma).toBeGreaterThanOrEqual(1);
  });
});

describe('estimatePtbCrossProbability', () => {
  const baseBand = 5;

  it('returns near-1 prob when spot already at PTB', () => {
    const ticks = genLine(0, 60_000, 0);
    const est = estimatePtbCrossProbability({
      pts: ticks,
      spot: 100,
      ptb: 100.05,
      endsInMs: 5 * 60_000,
      bandUsd: baseBand,
    });
    expect(est.prob).toBeGreaterThan(0.9);
  });

  it('returns near-0 prob when spot is far above PTB with downward drift suppressed by short horizon', () => {
    const ticks = genLine(0, 60_000, 0); // flat
    const est = estimatePtbCrossProbability({
      pts: ticks,
      spot: 200,
      ptb: 100,
      endsInMs: 30_000,
      bandUsd: 1,
    });
    expect(est.prob).toBeLessThan(0.1);
  });

  it('rises toward 1 when drift heads straight at PTB', () => {
    // start at 110, drift -$2/sec, PTB=100, 60s horizon — easily crosses.
    const t0 = 1_700_000_000_000;
    const ticks = genLine(t0, 60_000, -2);
    const est = estimatePtbCrossProbability({
      pts: ticks,
      spot: 50, // post-drift spot is what we pass; pretend we walked to here from 110
      ptb: 100,
      endsInMs: 60_000,
      bandUsd: 1,
    });
    expect(est.prob).toBeGreaterThan(0.5);
  });

  it('returns null estimate when missing inputs', () => {
    const est = estimatePtbCrossProbability({
      pts: [],
      spot: null,
      ptb: 100,
      endsInMs: 60_000,
      bandUsd: baseBand,
    });
    expect(est.prob).toBe(0);
    expect(est.confidence).toBe('low');
  });

  it('endAbove ≈ 1 when spot is far above PTB and horizon short', () => {
    const t0 = 1_700_000_000_000;
    const ticks = genLine(t0, 60_000, 0);
    const e = estimateEndingProbability({
      pts: ticks,
      spot: 200,
      ptb: 100,
      endsInMs: 60_000,
      bandUsd: 1,
    });
    expect(e.endAboveProb).toBeGreaterThan(0.95);
    expect(e.endBelowProb).toBeLessThan(0.05);
  });

  it('endBelow rises with strong downward drift', () => {
    const t0 = 1_700_000_000_000;
    const ticks: Tick[] = [];
    for (let i = 0; i <= 60; i++) ticks.push({ t: t0 + i * 1000, v: 100 - 0.5 * i });
    const e = estimateEndingProbability({
      pts: ticks,
      spot: 100,
      ptb: 100,
      endsInMs: 5 * 60_000,
      bandUsd: 1,
    });
    expect(e.endBelowProb).toBeGreaterThan(0.6);
  });

  it('endAboveProb defaults to 0.5 when inputs missing', () => {
    const e = estimateEndingProbability({
      pts: [],
      spot: null,
      ptb: 100,
      endsInMs: 60_000,
      bandUsd: 1,
    });
    expect(e.endAboveProb).toBe(0.5);
    expect(e.endBelowProb).toBe(0.5);
  });

  it('classifies confidence based on sample size and horizon', () => {
    const t0 = 1_700_000_000_000;
    const long = genLine(t0, 5 * 60_000, 0.1, 1000);
    const est = estimatePtbCrossProbability({
      pts: long,
      spot: long[long.length - 1]!.v,
      ptb: long[long.length - 1]!.v + 5,
      endsInMs: 5 * 60_000,
      bandUsd: 1,
    });
    expect(est.confidence).toBe('high');

    const tiny = long.slice(0, 5);
    const est2 = estimatePtbCrossProbability({
      pts: tiny,
      spot: tiny[tiny.length - 1]!.v,
      ptb: tiny[tiny.length - 1]!.v + 5,
      endsInMs: 5 * 60_000,
      bandUsd: 1,
    });
    expect(est2.confidence).toBe('low');
  });
});
