import { describe, expect, it } from 'vitest';

import { computeLaneEdges } from './tradeEdgeCalculator';

describe('computeLaneEdges', () => {
  it('returns nulls when ending probability is missing', () => {
    const e = computeLaneEdges({ upMid: 0.5, downMid: 0.5, endAboveProb: null });
    expect(e.up).toBeNull();
    expect(e.down).toBeNull();
    expect(e.bestLane).toBeNull();
  });

  it('flags strong UP edge when model gives 75% but mid is 0.55', () => {
    const e = computeLaneEdges({ upMid: 0.55, downMid: 0.45, endAboveProb: 0.75 });
    expect(e.up).not.toBeNull();
    expect(e.up?.edgePerShareUsd).toBeCloseTo(0.2, 2);
    expect(e.up?.quality).toBe('HIGH');
    expect(e.bestLane).toBe('up');
    expect(e.bestEdgeUsd).toBeGreaterThan(0.15);
  });

  it('flags negative DOWN edge when model gives 75% UP', () => {
    const e = computeLaneEdges({ upMid: 0.55, downMid: 0.45, endAboveProb: 0.75 });
    expect(e.down?.edgePerShareUsd).toBeLessThan(0);
    expect(e.down?.quality).toBe('NEGATIVE');
  });

  it('classifies medium edge between 0.05 and 0.12', () => {
    const e = computeLaneEdges({ upMid: 0.5, downMid: 0.5, endAboveProb: 0.6 });
    expect(e.up?.edgePerShareUsd).toBeCloseTo(0.1, 2);
    expect(e.up?.quality).toBe('MED');
  });

  it('classifies thin edge < 0.015 as THIN', () => {
    const e = computeLaneEdges({ upMid: 0.5, downMid: 0.5, endAboveProb: 0.51 });
    expect(e.up?.quality).toBe('THIN');
  });

  it('demotes quality one tier when modelConfidence is low', () => {
    // edge = 0.6 - 0.5 = 0.1 → MED at high conf, LOW at low conf
    const eHigh = computeLaneEdges({ upMid: 0.5, downMid: 0.5, endAboveProb: 0.6, modelConfidence: 'high' });
    const eLow = computeLaneEdges({ upMid: 0.5, downMid: 0.5, endAboveProb: 0.6, modelConfidence: 'low' });
    expect(eHigh.up?.quality).toBe('MED');
    expect(eLow.up?.quality).toBe('LOW');
  });

  it('returns no lane when mids are 0/1 (untradable)', () => {
    const e = computeLaneEdges({ upMid: 1, downMid: 0, endAboveProb: 0.6 });
    expect(e.up).toBeNull();
    expect(e.down).toBeNull();
  });

  it('breakeven equals mid', () => {
    const e = computeLaneEdges({ upMid: 0.62, downMid: 0.38, endAboveProb: 0.7 });
    expect(e.up?.breakevenProb).toBe(0.62);
    expect(e.down?.breakevenProb).toBe(0.38);
  });

  it('evPerDollar = edge/mid', () => {
    const e = computeLaneEdges({ upMid: 0.5, downMid: 0.5, endAboveProb: 0.7 });
    expect(e.up?.evPerDollar).toBeCloseTo(0.4, 2); // (0.7-0.5)/0.5
  });

  it('infers missing DOWN mid from UP so both lane edges exist', () => {
    const e = computeLaneEdges({ upMid: 0.55, downMid: null, endAboveProb: 0.72 });
    expect(e.down).not.toBeNull();
    expect(e.down!.mid).toBeCloseTo(0.45, 2);
    expect(e.down!.pWin).toBeCloseTo(0.28, 2);
    expect(e.down!.edgePerShareUsd).toBeCloseTo(0.28 - 0.45, 2);
  });

  it('on identical positive edges, bestLane is null (no silent UP/DOWN tie-break)', () => {
    const e = computeLaneEdges({ upMid: 0.5, downMid: 0.3, endAboveProb: 0.6 });
    expect(e.up?.edgePerShareUsd).toBeCloseTo(0.1, 5);
    expect(e.down?.edgePerShareUsd).toBeCloseTo(0.1, 5);
    expect(e.bestLane).toBeNull();
    expect(e.bestEdgeUsd).toBeCloseTo(0.1, 5);
  });

  it('infers missing UP mid from DOWN so both lane edges exist', () => {
    const e = computeLaneEdges({ upMid: null, downMid: 0.42, endAboveProb: 0.65 });
    expect(e.up).not.toBeNull();
    expect(e.up!.mid).toBeCloseTo(0.58, 2);
    expect(e.up!.pWin).toBeCloseTo(0.65, 2);
  });
});
