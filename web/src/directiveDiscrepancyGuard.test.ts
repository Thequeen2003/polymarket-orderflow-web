import { describe, expect, it } from 'vitest';
import { detectDirectiveDiscrepancy } from './directiveDiscrepancyGuard';
import type { TradeDirective } from './tradeDirective';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';

function mkDirective(over: Partial<TradeDirective> = {}): TradeDirective {
  return {
    action: 'INITIATE',
    lane: 'up',
    urgency: 'soon',
    recommendedSize: 0.3,
    headline: 'INITIATE UP',
    reason: '',
    evidence: [],
    confidence: 'MED',
    defensive: false,
    edgePerShareUsd: 0.1,
    laneMid: 0.55,
    laneWinProb: 0.65,
    ...over,
  };
}

function mkReadout(over: Partial<SpotPtbMachineReadout> = {}): SpotPtbMachineReadout {
  return {
    agreementScore: 70,
    focusLane: 'up',
    laneVotes: { up: 5, down: 1 },
    regime: 'trend',
    urgency: 'med',
    probVsSpot: 'aligned',
    crossProb: 0.3,
    crossEstimate: null,
    acceleration: null,
    mtf: null,
    overextension: null,
    endingProb: null,
    edges: null,
    sensors: {
      spotVsPtb: 'up',
      impliedLeader: 'up',
      sectionalDrift: 'up',
      bookControl: 'up',
      microSlope: 'up',
      dwellBias: 'up',
      accel: 'idle',
      mtfDominant: null,
      overextended: null,
    },
    lines: [],
    ...over,
  };
}

describe('detectDirectiveDiscrepancy', () => {
  it('returns no warnings on healthy INITIATE with aligned readout', () => {
    const r = detectDirectiveDiscrepancy(mkDirective(), mkReadout());
    expect(r.warnings).toHaveLength(0);
    expect(r.shouldBlock).toBe(false);
  });

  it('skips check on non-actionable directives', () => {
    const r = detectDirectiveDiscrepancy(mkDirective({ action: 'HOLD' }), mkReadout({
      mtf: {
        votes: [],
        alignedCount: 4,
        totalActionable: 4,
        dominantLane: 'down',
        score: -1,
        fullAgreement: true,
        hasConflict: false,
        summary: '',
      },
    }));
    expect(r.warnings).toHaveLength(0);
  });

  it('flags high-severity MTF_OPPOSITE when stack is full opposite', () => {
    const r = detectDirectiveDiscrepancy(
      mkDirective({ lane: 'up' }),
      mkReadout({
        mtf: {
          votes: [],
          alignedCount: 4,
          totalActionable: 4,
          dominantLane: 'down',
          score: -1,
          fullAgreement: true,
          hasConflict: false,
          summary: '',
        },
      }),
    );
    expect(r.warnings.some((w) => w.kind === 'MTF_OPPOSITE' && w.severity === 'high')).toBe(true);
    expect(r.shouldBlock).toBe(false);
  });

  it('flags OVEREXTENDED_CHASE high severity at high overextension', () => {
    const r = detectDirectiveDiscrepancy(
      mkDirective({ lane: 'up' }),
      mkReadout({
        overextension: {
          state: 'overextended',
          recentMoveUsd: 80,
          baselineMedianUsd: 20,
          ratio: 4,
          severity: 90,
          direction: 'up',
          summary: '',
        },
      }),
    );
    expect(r.warnings.some((w) => w.kind === 'OVEREXTENDED_CHASE' && w.severity === 'high')).toBe(true);
  });

  it('flags CROSS_PROB_AGAINST when cross prob is high on INITIATE', () => {
    const r = detectDirectiveDiscrepancy(mkDirective({ lane: 'up' }), mkReadout({ crossProb: 0.85 }));
    expect(r.warnings.some((w) => w.kind === 'CROSS_PROB_AGAINST' && w.severity === 'high')).toBe(true);
  });

  it('flags NEGATIVE_EDGE when edge is negative', () => {
    const r = detectDirectiveDiscrepancy(
      mkDirective({ edgePerShareUsd: -0.05 }),
      mkReadout(),
    );
    expect(r.warnings.some((w) => w.kind === 'NEGATIVE_EDGE')).toBe(true);
    expect(r.shouldBlock).toBe(false);
  });

  it('flags CHOP_REGIME on INITIATE in chop regime', () => {
    const r = detectDirectiveDiscrepancy(mkDirective(), mkReadout({ regime: 'chop' }));
    expect(r.warnings.some((w) => w.kind === 'CHOP_REGIME')).toBe(true);
  });

  it('aggregates multiple warnings into a higher score', () => {
    const r = detectDirectiveDiscrepancy(
      mkDirective({ lane: 'up' }),
      mkReadout({
        regime: 'chop',
        crossProb: 0.85,
        overextension: {
          state: 'overextended',
          recentMoveUsd: 80,
          baselineMedianUsd: 20,
          ratio: 4,
          severity: 90,
          direction: 'up',
          summary: '',
        },
      }),
    );
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
    expect(r.score).toBeGreaterThan(40);
    expect(r.shouldBlock).toBe(true);
  });

  it('returns empty when inputs missing', () => {
    expect(detectDirectiveDiscrepancy(null, null).any).toBe(false);
    expect(detectDirectiveDiscrepancy(mkDirective(), null).any).toBe(false);
    expect(detectDirectiveDiscrepancy(null, mkReadout()).any).toBe(false);
  });
});
