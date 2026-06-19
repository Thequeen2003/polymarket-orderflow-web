import { describe, expect, it } from 'vitest';
import { computeDeskSpeedSnapshot } from './deskSpeedLayers';
import { DIRECTION_CONFLICT_BLOCK_PCT, computeDirectionEngine } from './directionEngine';
import type { MtfConsensus } from './multiTimeframeConsensus';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';

function machineBase(overrides: Partial<SpotPtbMachineReadout> = {}): SpotPtbMachineReadout {
  return {
    agreementScore: 70,
    focusLane: 'down',
    laneVotes: { up: 2, down: 4 },
    regime: 'trend',
    urgency: 'med',
    probVsSpot: 'aligned',
    crossProb: 0.99,
    crossEstimate: null,
    acceleration: null,
    mtf: null,
    overextension: null,
    endingProb: null,
    edges: null,
    flowWinningLane: 'up',
    wallFlow: null,
    sensors: {
      spotVsPtb: 'down',
      impliedLeader: 'down',
      sectionalDrift: 'down',
      bookControl: 'up',
      microSlope: 'down',
      dwellBias: 'down',
      accel: 'building',
      mtfDominant: 'down',
      overextended: null,
      tapeDominance: 'sell',
      tapeReliable: true,
      upBidWall: false,
      upAskWall: false,
      downBidWall: true,
      downAskWall: false,
    },
    lines: [],
    ...overrides,
  };
}

function mtfDown(): MtfConsensus {
  return {
    votes: [],
    alignedCount: 3,
    totalActionable: 4,
    dominantLane: 'down',
    score: 0.75,
    fullAgreement: false,
    hasConflict: false,
    summary: '3/4 DOWN',
  };
}

describe('computeDirectionEngine', () => {
  it('hard rule ENTER DOWN overrides tier-2 order-flow conflict', () => {
    const tEnd = 100_000;
    const deskSpeed = computeDeskSpeedSnapshot({
      spotPts: [
        { t: tEnd - 30_000, v: 70_000 },
        { t: tEnd, v: 69_750 },
      ],
      nowSpot: 69_750,
      ptb: 70_100,
      probUpPts: [
        { t: tEnd - 30_000, v: 0.55 },
        { t: tEnd, v: 0.35 },
      ],
      pMktUp: 0.35,
      probDownPts: [
        { t: tEnd - 30_000, v: 0.45 },
        { t: tEnd, v: 0.65 },
      ],
      pMktDown: 0.65,
      horizonSec: 30,
    });

    const signal = computeDirectionEngine({
      geo: 'BELOW',
      modelPUp: 0.288,
      pMktUp: 0.35,
      deskSpeed,
      machine: machineBase({ flowWinningLane: 'up', sensors: { ...machineBase().sensors, bookControl: 'up' } }),
      mtf: mtfDown(),
      edgePp: -17.9,
      contractLag: {
        modelUp: 0.288,
        modelDown: 0.712,
        marketUp: 0.35,
        marketDown: 0.65,
        lagUpCents: -6.2,
        lagDownCents: 17.9,
        favoredSide: 'down',
        favoredLabel: 'DOWN',
        lagCents: 17.9,
        edgePp: -17.9,
        marketDeltaUpCents: -2,
        marketDeltaDownCents: 1.5,
        phase: 'lagging',
        phaseLabel: 'Lagging',
        repricingIntoEdge: false,
        geo: 'BELOW',
        geoAligned: true,
        tradeable: true,
        call: 'DOWN lag',
        detail: 'test',
        marketUpdatedAtMs: tEnd,
        marketAgeSec: 1,
        marketStale: false,
      },
      repricingIntoEdge: false,
    });

    expect(signal.verdict).toBe('ENTER_DOWN');
    expect(signal.hardRule).toBe(true);
    expect(signal.confidencePct).toBeGreaterThanOrEqual(75);
    expect(signal.repricingLabel).toBe('NOT STARTED');
    expect(signal.edgeCents).toBe('+17.9¢');
    expect(signal.conflictPct).toBeGreaterThan(0);
  });

  it('NO TRADE when conflict exceeds block threshold without hard rule', () => {
    const signal = computeDirectionEngine({
      geo: 'BELOW',
      modelPUp: 0.48,
      pMktUp: 0.5,
      deskSpeed: null,
      machine: machineBase({ flowWinningLane: 'up', focusLane: 'up' }),
      mtf: { ...mtfDown(), dominantLane: 'up', summary: '3/4 UP' },
      edgePp: -2,
      repricingIntoEdge: false,
    });

    expect(signal.verdict).toBe('NO_TRADE');
    expect(signal.hardRule).toBe(false);
    expect(signal.conflictPct).toBeGreaterThan(DIRECTION_CONFLICT_BLOCK_PCT);
  });

  it('ENTER UP with confidence when tier-1 aligns and tier-2 confirms', () => {
    const tEnd = 100_000;
    const deskSpeed = computeDeskSpeedSnapshot({
      spotPts: [
        { t: tEnd - 30_000, v: 70_000 },
        { t: tEnd, v: 70_250 },
      ],
      nowSpot: 70_250,
      ptb: 70_100,
      probUpPts: [
        { t: tEnd - 30_000, v: 0.55 },
        { t: tEnd, v: 0.72 },
      ],
      pMktUp: 0.72,
      probDownPts: [
        { t: tEnd - 30_000, v: 0.45 },
        { t: tEnd, v: 0.28 },
      ],
      pMktDown: 0.28,
      horizonSec: 30,
    });

    const signal = computeDirectionEngine({
      geo: 'ABOVE',
      modelPUp: 0.991,
      pMktUp: 0.72,
      deskSpeed,
      machine: machineBase({
        focusLane: 'up',
        flowWinningLane: 'up',
        sensors: { ...machineBase().sensors, spotVsPtb: 'up', bookControl: 'up' },
      }),
      mtf: {
        votes: [],
        alignedCount: 4,
        totalActionable: 4,
        dominantLane: 'up',
        score: 0.9,
        fullAgreement: true,
        hasConflict: false,
        summary: '4/4 UP',
      },
      edgePp: 27.1,
      repricingIntoEdge: false,
    });

    expect(signal.verdict).toBe('ENTER_UP');
    expect(signal.confidencePct).toBeGreaterThanOrEqual(70);
    expect(signal.conflictPct).toBeLessThanOrEqual(DIRECTION_CONFLICT_BLOCK_PCT);
  });
});
