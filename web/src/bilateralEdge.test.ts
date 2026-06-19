import { describe, expect, it } from 'vitest';
import {
  computeBilateralEdge,
  pickEdgeLaneHint,
  pickLeadingSideByScore,
  pickStrongerEdgeSide,
} from './bilateralEdge';

describe('computeBilateralEdge', () => {
  it('computes DOWN edge from actual DOWN mid, not −edgeUp', () => {
    const snap = computeBilateralEdge({
      modelPUp: 0.22,
      pMktUp: 0.48,
      pMktDown: 0.54,
    });
    expect(snap.modelPDown).toBeCloseTo(0.78, 4);
    expect(snap.edgeUpPp).toBeCloseTo(-26, 0);
    expect(snap.edgeDownPp).toBeCloseTo(24, 0);
    expect(snap.edgeDownPp).not.toBeCloseTo(-snap.edgeUpPp!, 0);
  });

  it('falls back to complement when pMktDown omitted', () => {
    const snap = computeBilateralEdge({ modelPUp: 0.8, pMktUp: 0.55 });
    expect(snap.pMktDown).toBeCloseTo(0.45, 4);
    expect(snap.edgeUpPp).toBeCloseTo(25, 0);
    expect(snap.edgeDownPp).toBeCloseTo(-25, 0);
  });
});

describe('pickStrongerEdgeSide', () => {
  it('prefers DOWN when DOWN edge is higher on tie-break', () => {
    expect(pickStrongerEdgeSide(7, 12)).toBe('down');
    expect(pickStrongerEdgeSide(25, 30)).toBe('down');
  });

  it('prefers UP when UP edge is higher', () => {
    expect(pickStrongerEdgeSide(18, 5)).toBe('up');
  });
});

describe('pickLeadingSideByScore', () => {
  it('uses edge strength when pass counts tie', () => {
    const up = { passCount: 1, edgePp: 8 };
    const down = { passCount: 1, edgePp: 15 };
    expect(pickLeadingSideByScore(up, down)).toBe(down);
  });
});

describe('pickEdgeLaneHint', () => {
  it('picks DOWN when only DOWN clears threshold with bilateral math', () => {
    expect(pickEdgeLaneHint(-26, 24, 20)).toBe('down');
  });
});
