import { describe, expect, it } from 'vitest';

import { pickStrongerBuyAdvisory, shouldBuyWhichSide, type ShouldBuyInput } from './shouldBuyWhichSide';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { TapeVelocity } from './tapeVelocity';

function baseMachine(overrides: Partial<SpotPtbMachineReadout> = {}): SpotPtbMachineReadout {
  return {
    agreementScore: 70,
    focusLane: 'up',
    laneVotes: { up: 6.5, down: 2.1 },
    regime: 'trend',
    urgency: 'low',
    probVsSpot: 'aligned',
    crossProb: 0.4,
    crossEstimate: null,
    acceleration: null,
    mtf: null,
    overextension: null,
    endingProb: null,
    edges: {
      up: { lane: 'up', mid: 0.52, pWin: 0.62, edgePerShareUsd: 0.10, evPerDollar: 0.192, breakevenProb: 0.52, marginOverBreakeven: 0.10, quality: 'MED', summary: '' },
      down: { lane: 'down', mid: 0.48, pWin: 0.38, edgePerShareUsd: -0.10, evPerDollar: -0.208, breakevenProb: 0.48, marginOverBreakeven: -0.10, quality: 'NEGATIVE', summary: '' },
      bestLane: 'up',
      bestEdgeUsd: 0.10,
    },
    flowWinningLane: 'up',
    wallFlow: null,
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
      tapeDominance: 'buy',
      tapeReliable: true,
      upBidWall: false,
      upAskWall: false,
      downBidWall: false,
      downAskWall: false,
    },
    lines: [],
    ...overrides,
  };
}

function baseTape(overrides: Partial<TapeVelocity> = {}): TapeVelocity {
  return {
    recent: { buyVol: 500, sellVol: 150, count: 12, net: 350 },
    baseline: { buyVol: 1000, sellVol: 900, count: 50, net: 100 },
    burstRatio: 2.5,
    burst: 'aggressive',
    netPressure: 65,
    dominance: 'buy',
    reliable: true,
    summary: '',
    micro: { buyVol: 200, sellVol: 40, count: 4, net: 160 },
    microBurstRatio: 3.0,
    microReliable: true,
    microDominance: 'buy',
    acceleration: 'building',
    microNetPressure: 70,
    ...overrides,
  };
}

function baseInput(overrides: Partial<ShouldBuyInput> = {}): ShouldBuyInput {
  return {
    machine: baseMachine(),
    tape: baseTape(),
    tapeLane: 'up',
    forecast: null,
    directive: null,
    stability: null,
    ...overrides,
  };
}

describe('pickStrongerBuyAdvisory', () => {
  it('prefers directional fallback over desk NEITHER', () => {
    const desk = shouldBuyWhichSide({ ...baseInput(), machine: null });
    const fallback = shouldBuyWhichSide(baseInput());
    expect(pickStrongerBuyAdvisory(desk, fallback).verdict).toBe('BUY_UP');
  });
});

describe('shouldBuyWhichSide book-only', () => {
  it('picks side from dual GO on sports desk', () => {
    const result = shouldBuyWhichSide({
      machine: null,
      book: {
        dual: {
          lane: 'down',
          verdict: 'ENTER',
          gate: 'ARMED',
          go: true,
          enterOnlyIf: 'Dual closed above entry',
          laneLock: { lane: 'down', status: 'LOCKED', confidence: 'HIGH', reason: 'Momentum' },
        },
        wallFlow: null,
        probUp: 0.31,
        probDown: 0.69,
        midUp: 0.31,
        midDown: 0.69,
      },
      tape: null,
      tapeLane: null,
      forecast: null,
      directive: null,
      stability: null,
      upLabel: 'Toronto Blue Jays',
      downLabel: 'Atlanta Braves',
    });
    expect(result.verdict).toBe('BUY_DOWN');
    expect(result.recommendation).toMatch(/ATLANTA|Braves|DOWN/i);
  });
});

describe('shouldBuyWhichSide', () => {
  it('returns NEITHER when machine is null', () => {
    const result = shouldBuyWhichSide({ ...baseInput(), machine: null });
    expect(result.verdict).toBe('NEITHER');
    expect(result.suggestedSize).toBe(0);
  });

  it('returns BUY_UP when all sensors point up', () => {
    const result = shouldBuyWhichSide(baseInput());
    expect(result.verdict).toBe('BUY_UP');
    expect(result.confidence).not.toBe('LOW');
    expect(result.confidencePct).toBeGreaterThanOrEqual(48);
    expect(result.momentumScore).toBeGreaterThan(0);
    expect(result.suggestedSize).toBeGreaterThan(0);
    expect(result.edgePerShareUsd).toBe(0.10);
  });

  it('returns BUY_DOWN when machine consensus is down', () => {
    const machine = baseMachine({
      focusLane: 'down',
      laneVotes: { up: 2.0, down: 7.0 },
      agreementScore: 75,
      flowWinningLane: 'down',
      edges: {
        up: { lane: 'up', mid: 0.48, pWin: 0.35, edgePerShareUsd: -0.13, evPerDollar: -0.27, breakevenProb: 0.48, marginOverBreakeven: -0.13, quality: 'NEGATIVE', summary: '' },
        down: { lane: 'down', mid: 0.52, pWin: 0.65, edgePerShareUsd: 0.13, evPerDollar: 0.25, breakevenProb: 0.52, marginOverBreakeven: 0.13, quality: 'HIGH', summary: '' },
        bestLane: 'down',
        bestEdgeUsd: 0.13,
      },
    });
    const tape = baseTape({ dominance: 'sell', netPressure: -60, microDominance: 'sell' });
    const result = shouldBuyWhichSide(baseInput({ machine, tape, tapeLane: 'up' }));
    expect(result.verdict).toBe('BUY_DOWN');
    expect(result.edgePerShareUsd).toBe(0.13);
  });

  it('returns NEITHER when agreement is below threshold', () => {
    const machine = baseMachine({ agreementScore: 30, laneVotes: { up: 1.5, down: 0.2 } });
    const result = shouldBuyWhichSide(baseInput({ machine }));
    expect(result.verdict).toBe('NEITHER');
  });

  it('returns NEITHER when scores are too close and no focus lane', () => {
    const machine = baseMachine({
      agreementScore: 60,
      laneVotes: { up: 4.0, down: 3.9 },
      focusLane: null,
      flowWinningLane: null,
      edges: null,
    });
    const result = shouldBuyWhichSide(baseInput({ machine, tape: null, directive: null }));
    expect(result.verdict).toBe('NEITHER');
    expect(result.scores.up).toBeGreaterThan(0);
    expect(result.scores.down).toBeGreaterThan(0);
  });

  it('uses focus lane when score margin is thin but agreement is sufficient', () => {
    const machine = baseMachine({
      agreementScore: 47,
      laneVotes: { up: 3.1, down: 2.5 },
      focusLane: 'up',
      flowWinningLane: 'up',
      edges: null,
    });
    const result = shouldBuyWhichSide(baseInput({ machine, tape: null }));
    expect(result.verdict).toBe('BUY_UP');
  });

  it('merges dual GO book votes into PTB machine readout', () => {
    const machine = baseMachine({
      agreementScore: 47,
      laneVotes: { up: 2.0, down: 2.1 },
      focusLane: 'down',
      flowWinningLane: 'down',
      edges: null,
    });
    const result = shouldBuyWhichSide(
      baseInput({
        machine,
        tape: null,
        book: {
          dual: {
            lane: 'down',
            verdict: 'ENTER',
            gate: 'ARMED',
            go: true,
            enterOnlyIf: 'Dual closed above entry',
            laneLock: { lane: 'down', status: 'LOCKED', confidence: 'HIGH', reason: 'Momentum' },
          },
          wallFlow: null,
          probUp: 0.42,
          probDown: 0.58,
          midUp: 0.42,
          midDown: 0.58,
        },
      }),
    );
    expect(result.verdict).toBe('BUY_DOWN');
  });

  it('reduces size in choppy regime', () => {
    const trendResult = shouldBuyWhichSide(baseInput());
    const chopMachine = baseMachine({ regime: 'chop' });
    const chopResult = shouldBuyWhichSide(baseInput({ machine: chopMachine }));
    expect(chopResult.verdict).toBe('BUY_UP');
    expect(chopResult.suggestedSize).toBeLessThan(trendResult.suggestedSize);
  });

  it('reduces size when overextended in the winning direction', () => {
    const normalResult = shouldBuyWhichSide(baseInput());
    const overextMachine = baseMachine({
      overextension: { state: 'overextended', direction: 'up', ratio: 3.2, summary: 'UP ×3.2' },
    });
    const overextResult = shouldBuyWhichSide(baseInput({ machine: overextMachine }));
    expect(overextResult.verdict).toBe('BUY_UP');
    expect(overextResult.suggestedSize).toBeLessThan(normalResult.suggestedSize);
    expect(overextResult.risks.some(r => /overextended/i.test(r))).toBe(true);
  });

  it('includes risk note when flow conflicts with the call', () => {
    const machine = baseMachine({ flowWinningLane: 'down' });
    const result = shouldBuyWhichSide(baseInput({ machine }));
    expect(result.risks.some(r => /opposes/i.test(r))).toBe(true);
  });

  it('sets cautionFresh when stability warns', () => {
    const stability = {
      tier: 'forming' as const,
      msSinceChange: 3000,
      flipsLastMin: 0,
      current: { ts: Date.now(), action: 'INITIATE' as const, lane: 'up' as const },
      previous: null,
      history: [],
      warnFresh: true,
      whipsaw: false,
      summary: '',
      rapidConviction: false,
    };
    const result = shouldBuyWhichSide(baseInput({ stability }));
    expect(result.cautionFresh).toBe(true);
  });

  it('boosts score from directive INITIATE alignment', () => {
    const directive = {
      action: 'INITIATE' as const,
      lane: 'up' as const,
      urgency: 'soon' as const,
      recommendedSize: 0.6,
      headline: 'INITIATE UP',
      reason: 'test',
      evidence: [],
      confidence: 'HIGH' as const,
      defensive: false,
      edgePerShareUsd: 0.10,
      laneMid: 0.52,
      laneWinProb: 0.62,
      laneOutcomeLabel: 'UP',
    };
    const withDirective = shouldBuyWhichSide(baseInput({ directive }));
    const withoutDirective = shouldBuyWhichSide(baseInput());
    expect(withDirective.scores.up).toBeGreaterThan(withoutDirective.scores.up);
  });

  it('uses forecast GO_IN to boost lane score', () => {
    const forecast = {
      status: 'GO_IN' as const,
      lane: 'up' as const,
      driftLane: 'up' as const,
      incomingLane: null,
      confidence: 'HIGH' as const,
      etaSec: null,
      headline: 'GO',
      reason: 'drift',
    } as any;
    const result = shouldBuyWhichSide(baseInput({ forecast }));
    expect(result.verdict).toBe('BUY_UP');
    expect(result.scores.up).toBeGreaterThan(0);
  });

  it('returns zero size when edge is negative', () => {
    const machine = baseMachine({
      laneVotes: { up: 6.0, down: 1.0 },
      agreementScore: 65,
      edges: {
        up: { lane: 'up', mid: 0.60, pWin: 0.45, edgePerShareUsd: -0.15, evPerDollar: -0.25, breakevenProb: 0.60, marginOverBreakeven: -0.15, quality: 'NEGATIVE', summary: '' },
        down: null,
        bestLane: null,
        bestEdgeUsd: 0,
      },
    });
    const result = shouldBuyWhichSide(baseInput({ machine }));
    expect(result.suggestedSize).toBe(0);
  });
});
