import { describe, expect, it } from 'vitest';
import { computeSizingMultiplier } from './directiveSizingMultiplier';
import type { DirectiveStability } from './directiveStability';
import type { DirectiveDiscrepancy } from './directiveDiscrepancyGuard';
import type { LaneEdges, TradeEdge } from './tradeEdgeCalculator';

function mkStability(tier: DirectiveStability['tier']): DirectiveStability {
  return {
    tier,
    msSinceChange: 0,
    flipsLastMin: tier === 'whipsaw' ? 5 : 0,
    current: { ts: 0, action: 'INITIATE', lane: 'up' },
    previous: null,
    history: [],
    warnFresh: tier === 'forming' || tier === 'whipsaw',
    whipsaw: tier === 'whipsaw',
    summary: '',
  };
}

function mkDiscrepancy(over: Partial<DirectiveDiscrepancy>): DirectiveDiscrepancy {
  return {
    warnings: [],
    score: 0,
    shouldBlock: false,
    any: false,
    ...over,
  };
}

function mkLaneEdges(quality: TradeEdge['quality']): LaneEdges {
  const up: TradeEdge = {
    lane: 'up',
    mid: 0.5,
    pWin: 0.6,
    edgePerShareUsd: 0.1,
    evPerDollar: 0,
    breakevenProb: 0.5,
    marginOverBreakeven: 0.1,
    quality,
    summary: '',
  };
  return { up, down: null, bestLane: 'up', bestEdgeUsd: 0.1 };
}

describe('computeSizingMultiplier', () => {
  it('returns 1.0 with no inputs', () => {
    const r = computeSizingMultiplier({});
    expect(r.combined).toBe(1);
    expect(r.notes).toHaveLength(0);
  });

  it('shrinks for whipsaw stability', () => {
    const r = computeSizingMultiplier({ stability: mkStability('whipsaw') });
    expect(r.stabilityFactor).toBe(0.3);
    expect(r.combined).toBeCloseTo(0.3, 5);
    expect(r.notes.some((n) => /whipsaw/.test(n))).toBe(true);
  });

  it('full size on stable directive', () => {
    const r = computeSizingMultiplier({ stability: mkStability('stable') });
    expect(r.stabilityFactor).toBe(1);
    expect(r.combined).toBe(1);
  });

  it('shrinks 0.4 on HIGH-severity discrepancy', () => {
    const r = computeSizingMultiplier({
      discrepancy: mkDiscrepancy({
        warnings: [{ kind: 'MTF_OPPOSITE', severity: 'high', message: '' }],
        score: 35,
        shouldBlock: true,
        any: true,
      }),
    });
    expect(r.discrepancyFactor).toBe(0.4);
    expect(r.combined).toBe(0.4);
  });

  it('shrinks 0.7 on MED discrepancy', () => {
    const r = computeSizingMultiplier({
      discrepancy: mkDiscrepancy({
        warnings: [{ kind: 'CHOP_REGIME', severity: 'med', message: '' }],
        score: 18,
        any: true,
      }),
    });
    expect(r.discrepancyFactor).toBe(0.7);
  });

  it('shrinks 0.85 on LOW-only discrepancy', () => {
    const r = computeSizingMultiplier({
      discrepancy: mkDiscrepancy({
        warnings: [{ kind: 'CONFLICT_SIDE', severity: 'low', message: '' }],
        score: 8,
        any: true,
      }),
    });
    expect(r.discrepancyFactor).toBe(0.85);
  });

  it('shrinks for THIN edge quality', () => {
    const r = computeSizingMultiplier({ lane: 'up', edges: mkLaneEdges('THIN') });
    expect(r.edgeQualityFactor).toBe(0.5);
    expect(r.combined).toBe(0.5);
  });

  it('shrinks 0.4 on active cool-down', () => {
    const r = computeSizingMultiplier({ cooldownActive: true });
    expect(r.cooldownFactor).toBe(0.4);
    expect(r.combined).toBe(0.4);
    expect(r.notes.some((n) => /cool-down/.test(n))).toBe(true);
  });

  it('combines factors multiplicatively', () => {
    const r = computeSizingMultiplier({
      stability: mkStability('forming'),
      discrepancy: mkDiscrepancy({
        warnings: [{ kind: 'MTF_OPPOSITE', severity: 'high', message: '' }],
        score: 35,
        shouldBlock: true,
        any: true,
      }),
      lane: 'up',
      edges: mkLaneEdges('LOW'),
      cooldownActive: true,
    });
    // 0.6 * 0.4 * 0.7 * 0.4 = 0.0672
    expect(r.combined).toBeCloseTo(0.0672, 4);
    expect(r.notes.length).toBeGreaterThanOrEqual(4);
  });

  it('clamps to 0..1', () => {
    const r = computeSizingMultiplier({});
    expect(r.combined).toBeGreaterThanOrEqual(0);
    expect(r.combined).toBeLessThanOrEqual(1);
  });
});
