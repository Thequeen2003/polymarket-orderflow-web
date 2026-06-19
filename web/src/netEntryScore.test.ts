import { describe, expect, it } from 'vitest';
import { computeDeskSpeedSnapshot } from './deskSpeedLayers';
import { NET_ENTRY_THRESHOLD, computeNetEntryScore } from './netEntryScore';
import type { MtfConsensus } from './multiTimeframeConsensus';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';

function mtfUp4(): MtfConsensus {
  return {
    votes: [],
    alignedCount: 4,
    totalActionable: 4,
    dominantLane: 'up',
    score: 0.9,
    fullAgreement: true,
    hasConflict: false,
    summary: '4/4 UP',
  };
}

function machineUp(): SpotPtbMachineReadout {
  return {
    agreementScore: 88,
    focusLane: 'up',
    laneVotes: { up: 5, down: 1 },
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
      spotVsPtb: 'up',
      impliedLeader: 'up',
      sectionalDrift: 'up',
      bookControl: 'up',
      microSlope: 'up',
      dwellBias: 'up',
      accel: 'building',
      mtfDominant: 'up',
      overextended: null,
      tapeDominance: 'buy',
      tapeReliable: true,
      upBidWall: false,
      upAskWall: false,
      downBidWall: false,
      downAskWall: false,
    },
    lines: [],
  };
}

describe('computeNetEntryScore', () => {
  it('NO TRADE when net is inside ±threshold', () => {
    const signal = computeNetEntryScore({
      geo: 'IN_BAND',
      modelPUp: 0.51,
      pMktUp: 0.5,
      deskSpeed: null,
      machine: null,
      mtf: null,
      edgePp: 1,
    });
    expect(Math.abs(signal.netScore)).toBeLessThanOrEqual(NET_ENTRY_THRESHOLD);
    expect(signal.verdict).toBe('NO_TRADE');
    expect(signal.headline).toBe('NO TRADE');
  });

  it('ENTER UP extreme when all UP factors align (user example)', () => {
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

    const signal = computeNetEntryScore({
      geo: 'ABOVE',
      modelPUp: 0.991,
      pMktUp: 0.72,
      deskSpeed,
      machine: machineUp(),
      mtf: mtfUp4(),
      edgePp: 27.1,
    });

    expect(signal.verdict).toBe('ENTER_UP');
    expect(signal.headline).toBe('ENTER UP');
    expect(signal.netScore).toBeGreaterThan(NET_ENTRY_THRESHOLD);
    expect(signal.confidenceLabel).toBe('Extreme');
    expect(signal.confidencePct).toBeGreaterThanOrEqual(85);
    expect(signal.factors.filter((f) => f.upHit).length).toBeGreaterThanOrEqual(6);
  });

  it('ENTER DOWN when DOWN stack dominates', () => {
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

    const signal = computeNetEntryScore({
      geo: 'BELOW',
      modelPUp: 0.25,
      pMktUp: 0.35,
      deskSpeed,
      machine: {
        ...machineUp(),
        focusLane: 'down',
        flowWinningLane: 'down',
        regime: 'trend',
        sensors: { ...machineUp().sensors, spotVsPtb: 'down', bookControl: 'down' },
      },
      mtf: { ...mtfUp4(), dominantLane: 'down', summary: '4/4 DOWN' },
      edgePp: -10,
    });

    expect(signal.verdict).toBe('ENTER_DOWN');
    expect(signal.headline).toBe('ENTER DOWN');
  });
});
