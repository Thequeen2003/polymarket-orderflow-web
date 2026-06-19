import { describe, expect, it } from 'vitest';
import { computeDeskSpeedSnapshot } from './deskSpeedLayers';
import { computeContractEntryJump } from './deskSpeedGainPct';
import {
  EXEC_CONFIRM_HOLD_MS,
  EXEC_MIN_EDGE_PP,
  diagnoseBaseEdge,
  computeExecutionSignal,
  evaluateExecutionGates,
  suggestDynamicTpBand,
} from './executionSignal';
import { updateExecutionConfirm } from './executionConfirmTracker';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';

function machineTrend(): SpotPtbMachineReadout {
  return {
    agreementScore: 72,
    focusLane: 'up',
    laneVotes: { up: 4, down: 2 },
    regime: 'trend',
    urgency: 'med',
    probVsSpot: 'aligned',
    crossProb: 0.4,
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

function freshUpSetup(tEnd: number) {
  const ptb = 70_000;
  const spotPts = [
    { t: tEnd - 30_000, v: 69_985 },
    { t: tEnd - 12_000, v: 69_995 },
    { t: tEnd - 8_000, v: 70_005 },
    { t: tEnd - 4_000, v: 70_012 },
    { t: tEnd, v: 70_022 },
  ];
  const nowSpot = 70_022;
  const deskSpeedEarly = computeDeskSpeedSnapshot({
    spotPts,
    nowSpot,
    ptb,
    probUpPts: [
      { t: tEnd - 30_000, v: 0.55 },
      { t: tEnd - 10_000, v: 0.56 },
      { t: tEnd, v: 0.58 },
    ],
    pMktUp: 0.58,
    probDownPts: [
      { t: tEnd - 30_000, v: 0.45 },
      { t: tEnd, v: 0.42 },
    ],
    pMktDown: 0.42,
    horizonSec: 10,
  });
  const earlyJump = computeContractEntryJump({
    prob: deskSpeedEarly.lanes.up.prob,
    now01: 0.58,
    horizonSec: 10,
    outcomeLabel: 'UP',
  });
  return { spotPts, deskSpeedEarly, earlyJump, nowSpot, ptb };
}

describe('diagnoseBaseEdge', () => {
  it('lists missing prob and edge when below threshold', () => {
    const diag = diagnoseBaseEdge({
      geo: 'IN_BAND',
      modelPUp: 0.62,
      pMktUp: 0.55,
      pMktDown: 0.48,
      deskSpeedEarly: null,
      deskSpeedConfirm: null,
      machine: null,
      mtf: null,
    });
    expect(diag.leading.passCount).toBeLessThan(3);
    expect(diag.summary).toMatch(/building|No edge/i);
    expect(diag.leading.missNotes.some((m) => m.includes('pp'))).toBe(true);
  });

  it('leading side follows stronger bilateral DOWN edge under overround', () => {
    const diag = diagnoseBaseEdge({
      geo: 'BELOW',
      modelPUp: 0.22,
      pMktUp: 0.48,
      pMktDown: 0.54,
      deskSpeedEarly: null,
      deskSpeedConfirm: null,
      machine: null,
      mtf: null,
    });
    expect(diag.leading.side).toBe('down');
    expect(diag.down.edgePp).toBeCloseTo(24, 0);
    expect(diag.up.edgePp).toBeCloseTo(-26, 0);
  });

  it('does not add confirmation gate when base edge fails', () => {
    const signal = computeExecutionSignal({
      geo: 'IN_BAND',
      modelPUp: 0.55,
      pMktUp: 0.52,
      pMktDown: 0.51,
      deskSpeedEarly: null,
      deskSpeedConfirm: null,
      machine: null,
      mtf: null,
    });
    expect(signal.baseAlert).toBe(false);
    expect(signal.gates.some((g) => g.id === 'confirmHold')).toBe(false);
    expect(signal.bias).toBeDefined();
    expect(signal.entry.up.sideLabel).toMatch(/UP/i);
    expect(signal.entry.down.sideLabel).toMatch(/DOWN/i);
    expect(signal.phase === 'WAIT' || signal.phase === 'NO_TRADE').toBe(true);
  });
});

describe('suggestDynamicTpBand', () => {
  it('tightens TP in chop', () => {
    const band = suggestDynamicTpBand('CHOP', 'chop');
    expect(band.maxCents).toBeLessThanOrEqual(2);
  });

  it('widens TP in trend grind', () => {
    const band = suggestDynamicTpBand('TREND_GRIND', 'trend');
    expect(band.minCents).toBeGreaterThanOrEqual(3);
  });
});

describe('evaluateExecutionGates', () => {
  it('passes all gates on fresh continuation setup', () => {
    const tEnd = 200_000;
    const { spotPts, deskSpeedEarly, earlyJump, nowSpot } = freshUpSetup(tEnd);

    const snap = evaluateExecutionGates(
      {
        geo: 'ABOVE',
        modelPUp: 0.82,
        pMktUp: 0.58,
        edgePp: 24,
        deskSpeedEarly,
        deskSpeedConfirm: deskSpeedEarly,
        machine: machineTrend(),
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
        probUpDelta01: 0.01,
        spotPts,
        nowSpotUsd: nowSpot,
        earlyProbGainCents: earlyJump?.gainCents ?? 0,
        pressureTiming: 'EARLY',
      },
      tEnd,
    );

    expect(snap.proposedLane).toBe('up');
    expect(snap.allGatesPass).toBe(true);
  });

  it('blocks when contract already spiked on 10s', () => {
    const tEnd = 200_000;
    const spotPts = [
      { t: tEnd - 30_000, v: 70_000 },
      { t: tEnd, v: 70_200 },
    ];
    const deskSpeedEarly = computeDeskSpeedSnapshot({
      spotPts,
      nowSpot: 70_200,
      ptb: 70_100,
      probUpPts: [
        { t: tEnd - 10_000, v: 0.52 },
        { t: tEnd, v: 0.58 },
      ],
      pMktUp: 0.58,
      probDownPts: [
        { t: tEnd - 10_000, v: 0.48 },
        { t: tEnd, v: 0.42 },
      ],
      pMktDown: 0.42,
      horizonSec: 10,
    });

    const snap = evaluateExecutionGates({
      geo: 'ABOVE',
      modelPUp: 0.85,
      pMktUp: 0.58,
      edgePp: 27,
      deskSpeedEarly,
      deskSpeedConfirm: deskSpeedEarly,
      machine: machineTrend(),
      mtf: null,
      spotPts,
      nowSpotUsd: 70_200,
      earlyProbGainCents: 6,
      pressureTiming: 'EXTENDED',
    });

    expect(snap.allGatesPass).toBe(false);
    expect(snap.blockReasons.some((r) => r.includes('spike') || r.includes('extended') || r.includes('Chase'))).toBe(true);
  });
});

describe('computeExecutionSignal', () => {
  it('stays ALERT until confirmation hold completes', () => {
    const tEnd = 300_000;
    const { spotPts, deskSpeedEarly, earlyJump, nowSpot } = freshUpSetup(tEnd);
    const input = {
      geo: 'ABOVE' as const,
      modelPUp: 0.82,
      pMktUp: 0.58,
      edgePp: 24,
      deskSpeedEarly,
      deskSpeedConfirm: deskSpeedEarly,
      machine: machineTrend(),
      mtf: {
        votes: [],
        alignedCount: 4,
        totalActionable: 4,
        dominantLane: 'up' as const,
        score: 0.9,
        fullAgreement: true,
        hasConflict: false,
        summary: '4/4 UP',
      },
      probUpDelta01: 0.01,
      spotPts,
      nowSpotUsd: nowSpot,
      earlyProbGainCents: earlyJump?.gainCents ?? 0,
      pressureTiming: 'EARLY' as const,
    };

    const alert = computeExecutionSignal({ ...input, confirmHeldMs: 2_000 }, tEnd);
    expect(alert.phase).toBe('ALERT');
    expect(alert.verdict).toBe('WAIT');

    const enter = computeExecutionSignal({ ...input, confirmHeldMs: EXEC_CONFIRM_HOLD_MS }, tEnd);
    expect(enter.phase).toBe('ENTER');
    expect(enter.verdict).toBe('ENTER_UP');
  });

  it('updateExecutionConfirm accumulates hold time', () => {
    const tEnd = 400_000;
    const { spotPts, deskSpeedEarly, earlyJump, nowSpot } = freshUpSetup(tEnd);
    const input = {
      geo: 'ABOVE' as const,
      modelPUp: 0.82,
      pMktUp: 0.58,
      edgePp: EXEC_MIN_EDGE_PP + 4,
      deskSpeedEarly,
      deskSpeedConfirm: deskSpeedEarly,
      machine: machineTrend(),
      mtf: null,
      probUpDelta01: 0.008,
      spotPts,
      nowSpotUsd: nowSpot,
      earlyProbGainCents: earlyJump?.gainCents ?? 0,
      pressureTiming: 'EARLY' as const,
    };

    let state = updateExecutionConfirm(null, input, tEnd);
    expect(state.confirmHeldMs).toBe(0);

    state = updateExecutionConfirm(state, input, tEnd + 5_000);
    expect(state.confirmHeldMs).toBe(5_000);

    state = updateExecutionConfirm(state, input, tEnd + EXEC_CONFIRM_HOLD_MS);
    const signal = computeExecutionSignal({ ...input, confirmHeldMs: state.confirmHeldMs }, tEnd + EXEC_CONFIRM_HOLD_MS);
    expect(signal.verdict).toBe('ENTER_UP');
  });
});
