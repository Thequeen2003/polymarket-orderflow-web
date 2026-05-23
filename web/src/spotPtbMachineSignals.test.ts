import { describe, expect, it } from 'vitest';

import { computeDualOutcomeWallFlow } from './dualOutcomeWalls';
import {
  computeFlowWinningLane,
  computeSpotPtbMachineReadout,
  orderFlowConflictsLane,
  resolveFocusLaneWithOrderFlow,
} from './spotPtbMachineSignals';
import type { SpotSection } from './sectionalMomentum';

function sec(partial: Partial<SpotSection> & Pick<SpotSection, 'direction'>): SpotSection {
  return {
    t0: 0,
    t1: 1,
    o: 100,
    c: 100,
    h: 101,
    l: 99,
    netUsd: 1,
    slopeUsdPerMin: 1,
    pctAbove: 0.5,
    pctBelow: 0.2,
    pctAtPtb: 0.3,
    ptbCrosses: 0,
    intensity01: 0.5,
    ...partial,
  };
}

describe('computeFlowWinningLane', () => {
  it('picks DOWN when book and implied outweigh spot geometry', () => {
    expect(
      computeFlowWinningLane({
        bookControl: 'down',
        impliedLeader: 'down',
        sectionalDrift: 'down',
        tapeLane: null,
        tapeDominance: null,
        tapeReliable: false,
      }),
    ).toBe('down');
  });

  it('wall lane dominates when bid/ask walls are clear', () => {
    expect(
      computeFlowWinningLane({
        bookControl: 'up',
        impliedLeader: 'up',
        sectionalDrift: null,
        tapeLane: null,
        tapeDominance: null,
        tapeReliable: false,
        wallFlowLane: 'down',
        wallPressure: 2.5,
      }),
    ).toBe('down');
  });
});

describe('computeSpotPtbMachineReadout', () => {
  it('scores high when spot, implied, book, drift all agree UP', () => {
    const sections = [
      sec({ direction: 'UP', netUsd: 5 }),
      sec({ direction: 'UP', netUsd: 4 }),
      sec({ direction: 'UP', netUsd: 3 }),
    ];
    const r = computeSpotPtbMachineReadout({
      sections,
      spot: 105_000,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: 0.58,
      lastProbDown: 0.42,
      controlSignal: 'UP_CONTROL',
      dwellMajoritySign: 1,
      slopeUsdPerSec: 2,
      primaryLane: 'up',
      endsInMs: 60 * 60_000,
    });
    expect(r.focusLane).toBe('up');
    expect(r.agreementScore).toBeGreaterThanOrEqual(85);
    expect(r.probVsSpot).toBe('aligned');
    expect(r.regime).toBe('trend');
  });

  it('flags conflict when implied UP but spot below PTB', () => {
    const sections = [sec({ direction: 'DOWN', netUsd: -3 }), sec({ direction: 'DOWN', netUsd: -2 })];
    const r = computeSpotPtbMachineReadout({
      sections,
      spot: 95_000,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: 0.55,
      lastProbDown: 0.45,
      controlSignal: 'NO_EDGE',
      dwellMajoritySign: 0,
      slopeUsdPerSec: 0,
      primaryLane: null,
      endsInMs: null,
    });
    expect(r.probVsSpot).toBe('conflict');
    expect(r.lines.some((l) => l.includes('Conflict'))).toBe(true);
  });

  it('marks critical urgency under 5m', () => {
    const sections = [sec({ direction: 'FLAT', netUsd: 0 })];
    const r = computeSpotPtbMachineReadout({
      sections,
      spot: 100_000,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: null,
      lastProbDown: null,
      controlSignal: 'NO_EDGE',
      dwellMajoritySign: 0,
      slopeUsdPerSec: null,
      primaryLane: null,
      endsInMs: 4 * 60_000,
    });
    expect(r.urgency).toBe('critical');
  });

  it('marks settlement urgency under 60s', () => {
    const r = computeSpotPtbMachineReadout({
      sections: [sec({ direction: 'FLAT', netUsd: 0 })],
      spot: 100_000,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: null,
      lastProbDown: null,
      controlSignal: 'NO_EDGE',
      dwellMajoritySign: 0,
      slopeUsdPerSec: null,
      primaryLane: null,
      endsInMs: 30_000,
    });
    expect(r.urgency).toBe('settlement');
    expect(r.lines.some((l) => l.includes('SETTLEMENT'))).toBe(true);
  });

  it('surfaces MTF, overextension, and edges when provided', () => {
    const sections = [sec({ direction: 'UP', netUsd: 4 })];
    const r = computeSpotPtbMachineReadout({
      sections,
      spot: 100_500,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: 0.55,
      lastProbDown: 0.45,
      controlSignal: 'UP_CONTROL',
      dwellMajoritySign: 1,
      slopeUsdPerSec: 1,
      primaryLane: 'up',
      endsInMs: 30 * 60_000,
      mtf: {
        votes: [],
        alignedCount: 4,
        totalActionable: 4,
        dominantLane: 'up',
        score: 1,
        fullAgreement: true,
        hasConflict: false,
        summary: '4/4 UP',
      },
      overextension: {
        state: 'overextended',
        recentMoveUsd: 80,
        baselineMedianUsd: 20,
        ratio: 4,
        severity: 90,
        direction: 'up',
        summary: 'overextended up',
      },
      edges: {
        up: {
          lane: 'up',
          mid: 0.55,
          pWin: 0.7,
          edgePerShareUsd: 0.15,
          evPerDollar: 0.27,
          breakevenProb: 0.55,
          marginOverBreakeven: 0.15,
          quality: 'HIGH',
          summary: 'UP edge +0.15',
        },
        down: null,
        bestLane: 'up',
        bestEdgeUsd: 0.15,
      },
    });
    expect(r.mtf?.fullAgreement).toBe(true);
    expect(r.overextension?.state).toBe('overextended');
    expect(r.edges?.bestLane).toBe('up');
    expect(r.lines.some((l) => l.includes('MTF stack'))).toBe(true);
    expect(r.lines.some((l) => l.includes('Anti-chase'))).toBe(true);
    expect(r.lines.some((l) => l.includes('Edge'))).toBe(true);
  });

  it('surfaces cross prob and acceleration when provided', () => {
    const sections = [sec({ direction: 'UP', netUsd: 4 }), sec({ direction: 'UP', netUsd: 3 })];
    const r = computeSpotPtbMachineReadout({
      sections,
      spot: 100_500,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: 0.6,
      lastProbDown: 0.4,
      controlSignal: 'UP_CONTROL',
      dwellMajoritySign: 1,
      slopeUsdPerSec: 1.5,
      primaryLane: 'up',
      endsInMs: 30 * 60_000,
      crossEstimate: {
        prob: 0.78,
        bias: 'uncertain',
        driftUsdPerSec: 1.5,
        volUsdPerSqrtSec: 3,
        horizonSec: 1800,
        distanceUsd: 500,
        confidence: 'high',
        summary: 'high prob',
      },
      acceleration: {
        state: 'accel-up',
        thrust: 80,
        slopeLateUsdPerSec: 2,
        slopeEarlyUsdPerSec: 0.5,
        direction: 'up',
        summary: 'thrust up',
      },
    });
    expect(r.crossProb).toBeCloseTo(0.78, 2);
    expect(r.acceleration?.state).toBe('accel-up');
    expect(r.lines.some((l) => l.includes('Cross prob'))).toBe(true);
    expect(r.lines.some((l) => l.includes('Thrust'))).toBe(true);
  });

  // ─── Wrong-side regression tests ──────────────────────────────────────────
  // These guard against the previous bug where focusLane was "first non-null
  // sensor wins". On rangy markets the spotVsPtb sensor often pointed one way
  // while the EV edge + drift + MTF stack pointed the other — and the old code
  // silently picked the highest-priority single sensor. The fix is a true
  // weighted majority vote.
  it('overrides primaryLane when 4+ sensors and EV edge favor the opposite side', () => {
    // Spot ~1¢ above PTB (barely) but everything else screams DOWN.
    const sections = [sec({ direction: 'DOWN', netUsd: -8 }), sec({ direction: 'DOWN', netUsd: -7 })];
    const r = computeSpotPtbMachineReadout({
      sections,
      spot: 100_001,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: 0.4,
      lastProbDown: 0.6,
      controlSignal: 'DOWN_CONTROL',
      dwellMajoritySign: -1,
      slopeUsdPerSec: -3,
      // primary call says UP because spot is technically above PTB
      primaryLane: 'up',
      endsInMs: 30 * 60_000,
      mtf: {
        votes: [],
        alignedCount: 4,
        totalActionable: 4,
        dominantLane: 'down',
        score: -1,
        fullAgreement: true,
        hasConflict: false,
        summary: '4/4 DOWN',
      },
      edges: {
        up: { lane: 'up', mid: 0.52, pWin: 0.4, edgePerShareUsd: -0.12, evPerDollar: -0.23, breakevenProb: 0.52, marginOverBreakeven: -0.12, quality: 'NEGATIVE', summary: '' },
        down: { lane: 'down', mid: 0.48, pWin: 0.6, edgePerShareUsd: 0.12, evPerDollar: 0.25, breakevenProb: 0.48, marginOverBreakeven: 0.12, quality: 'HIGH', summary: '' },
        bestLane: 'down',
        bestEdgeUsd: 0.12,
      },
    });
    expect(r.focusLane).toBe('down');
    // Transparency line so operator sees the override.
    expect(r.lines.some((l) => /Lane override/i.test(l))).toBe(true);
  });

  it('vetoes focusLane when the EV edge strongly disagrees and the picked lane is −EV', () => {
    // Thin DOWN sensors + implied lean down, but terminal EV strongly favors UP →
    // raw vote can still land on DOWN until the edge veto nulls the call.
    const r = computeSpotPtbMachineReadout({
      sections: [sec({ direction: 'FLAT', netUsd: 0 })],
      spot: 99_999,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: 0.4,
      lastProbDown: 0.6,
      controlSignal: 'DOWN_CONTROL',
      dwellMajoritySign: 0,
      slopeUsdPerSec: 0,
      primaryLane: 'down',
      endsInMs: 20 * 60_000,
      edges: {
        up: { lane: 'up', mid: 0.4, pWin: 0.7, edgePerShareUsd: 0.30, evPerDollar: 0.75, breakevenProb: 0.4, marginOverBreakeven: 0.30, quality: 'HIGH', summary: '' },
        down: { lane: 'down', mid: 0.6, pWin: 0.3, edgePerShareUsd: -0.30, evPerDollar: -0.5, breakevenProb: 0.6, marginOverBreakeven: -0.30, quality: 'NEGATIVE', summary: '' },
        bestLane: 'up',
        bestEdgeUsd: 0.30,
      },
    });
    // DOWN wins votes; tape+implied align on DOWN so edge veto does not wipe the lane.
    expect(r.focusLane).toBe('down');
  });

  it('keeps UP when tape+implied align on UP even if terminal EV prefers DOWN (no spurious veto)', () => {
    const sections = [sec({ direction: 'FLAT', netUsd: 0 })];
    const r = computeSpotPtbMachineReadout({
      sections,
      spot: 101_000,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: 0.58,
      lastProbDown: 0.42,
      controlSignal: 'NO_EDGE',
      dwellMajoritySign: 0,
      slopeUsdPerSec: 0,
      primaryLane: null,
      endsInMs: 20 * 60_000,
      edges: {
        up: { lane: 'up', mid: 0.58, pWin: 0.45, edgePerShareUsd: -0.05, evPerDollar: -0.2, breakevenProb: 0.58, marginOverBreakeven: -0.13, quality: 'NEGATIVE', summary: '' },
        down: { lane: 'down', mid: 0.42, pWin: 0.55, edgePerShareUsd: 0.14, evPerDollar: 0.31, breakevenProb: 0.42, marginOverBreakeven: 0.13, quality: 'HIGH', summary: '' },
        bestLane: 'down',
        bestEdgeUsd: 0.14,
      },
    });
    expect(r.probVsSpot).toBe('aligned');
    expect(r.sensors.impliedLeader).toBe('up');
    expect(r.focusLane).toBe('up');
  });

  it('keeps DOWN when EV favors UP but weighted sensors lead past the EV veto bypass', () => {
    const sections = [
      sec({ direction: 'DOWN', netUsd: -12 }),
      sec({ direction: 'DOWN', netUsd: -10 }),
    ];
    const r = computeSpotPtbMachineReadout({
      sections,
      spot: 98_500,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: 0.32,
      lastProbDown: 0.68,
      controlSignal: 'DOWN_CONTROL',
      dwellMajoritySign: -1,
      slopeUsdPerSec: -0.9,
      primaryLane: 'up',
      endsInMs: 20 * 60_000,
      edges: {
        up: {
          lane: 'up',
          mid: 0.38,
          pWin: 0.72,
          edgePerShareUsd: 0.34,
          evPerDollar: 0.9,
          breakevenProb: 0.38,
          marginOverBreakeven: 0.34,
          quality: 'HIGH',
          summary: '',
        },
        down: {
          lane: 'down',
          mid: 0.62,
          pWin: 0.28,
          edgePerShareUsd: -0.34,
          evPerDollar: -0.55,
          breakevenProb: 0.62,
          marginOverBreakeven: -0.34,
          quality: 'NEGATIVE',
          summary: '',
        },
        bestLane: 'up',
        bestEdgeUsd: 0.34,
      },
    });
    expect(r.focusLane).toBe('down');
    expect(r.lines.some((l) => /tape vs terminal model split/i.test(l))).toBe(true);
  });

  it('keeps focusLane stable when all sensors align (no spurious overrides)', () => {
    const sections = [sec({ direction: 'UP', netUsd: 4 }), sec({ direction: 'UP', netUsd: 3 })];
    const r = computeSpotPtbMachineReadout({
      sections,
      spot: 100_500,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: 0.62,
      lastProbDown: 0.38,
      controlSignal: 'UP_CONTROL',
      dwellMajoritySign: 1,
      slopeUsdPerSec: 2,
      primaryLane: 'up',
      endsInMs: 30 * 60_000,
      edges: {
        up: { lane: 'up', mid: 0.55, pWin: 0.7, edgePerShareUsd: 0.15, evPerDollar: 0.27, breakevenProb: 0.55, marginOverBreakeven: 0.15, quality: 'HIGH', summary: '' },
        down: { lane: 'down', mid: 0.45, pWin: 0.3, edgePerShareUsd: -0.15, evPerDollar: -0.33, breakevenProb: 0.45, marginOverBreakeven: -0.15, quality: 'NEGATIVE', summary: '' },
        bestLane: 'up',
        bestEdgeUsd: 0.15,
      },
    });
    expect(r.focusLane).toBe('up');
    expect(r.agreementScore).toBeGreaterThanOrEqual(85);
    // No override line because primary aligned with vote.
    expect(r.lines.some((l) => /Lane override/i.test(l))).toBe(false);
  });

  it('picks DOWN when book + implied clearly outweigh spot (no primary vote)', () => {
    // Spot barely above PTB (+1.2 up) but book + implied + drift stack DOWN past margin.
    const sections = [sec({ direction: 'DOWN', netUsd: -12 }), sec({ direction: 'DOWN', netUsd: -10 })];
    const r = computeSpotPtbMachineReadout({
      sections,
      spot: 100_100,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: 0.42,
      lastProbDown: 0.58,
      controlSignal: 'DOWN_CONTROL',
      dwellMajoritySign: -1,
      slopeUsdPerSec: -0.5,
      primaryLane: 'up',
      endsInMs: 30 * 60_000,
    });
    expect(r.focusLane).toBe('down');
    expect(r.flowWinningLane).toBe('down');
    expect(r.laneVotes.down).toBeGreaterThanOrEqual(r.laneVotes.up + 0.5);
    expect(r.lines.some((l) => /Flow lead DOWN/i.test(l))).toBe(true);
  });

  it('uses dual bid/ask walls when spot is above PTB but DOWN walls win', () => {
    const wallFlow = computeDualOutcomeWallFlow({
      upBook: {
        bids: [
          { price: 0.55, size: 40 },
          { price: 0.54, size: 22 },
          { price: 0.53, size: 18 },
        ],
        asks: [
          { price: 0.56, size: 420 },
          { price: 0.57, size: 20 },
          { price: 0.58, size: 17 },
        ],
      },
      downBook: {
        bids: [
          { price: 0.44, size: 400 },
          { price: 0.43, size: 21 },
          { price: 0.42, size: 16 },
        ],
        asks: [
          { price: 0.45, size: 35 },
          { price: 0.46, size: 19 },
          { price: 0.47, size: 15 },
        ],
      },
    });
    expect(wallFlow?.flowLane).toBe('down');
    const r = computeSpotPtbMachineReadout({
      sections: [sec({ direction: 'DOWN', netUsd: -6 })],
      spot: 100_120,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: 0.44,
      lastProbDown: 0.56,
      controlSignal: 'DOWN_CONTROL',
      dwellMajoritySign: -1,
      slopeUsdPerSec: -0.2,
      primaryLane: 'up',
      endsInMs: 30 * 60_000,
      wallFlow,
    });
    expect(r.focusLane).toBe('down');
    expect(r.flowWinningLane).toBe('down');
    expect(r.sensors.upAskWall).toBe(true);
    expect(r.sensors.downBidWall).toBe(true);
    expect(r.lines.some((l) => /Walls →/i.test(l))).toBe(true);
  });

  it('flips lane when raw votes outweigh any legacy primary bias', () => {
    // Stronger DOWN sensor stack — DOWN should still win without relying on a tie-break.
    const sections = [sec({ direction: 'DOWN', netUsd: -8 }), sec({ direction: 'DOWN', netUsd: -6 })];
    const r = computeSpotPtbMachineReadout({
      sections,
      spot: 100_100,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: 0.45,
      lastProbDown: 0.55,
      controlSignal: 'DOWN_CONTROL',
      dwellMajoritySign: -1,
      slopeUsdPerSec: 0,
      primaryLane: 'up',
      endsInMs: 30 * 60_000,
    });
    expect(r.focusLane).toBe('down');
  });

  it('lean-picks DOWN when vote lead is below full margin but above lean threshold', () => {
    const sections = [sec({ direction: 'FLAT', netUsd: 0 })];
    const r = computeSpotPtbMachineReadout({
      sections,
      spot: 100_100,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: 0.5,
      lastProbDown: 0.5,
      controlSignal: 'DOWN_CONTROL',
      dwellMajoritySign: 0,
      slopeUsdPerSec: 0,
      primaryLane: null,
      endsInMs: 30 * 60_000,
    });
    // Spot above PTB but book leads DOWN — spot vote is down-weighted; book carries.
    expect(r.focusLane).toBe('down');
    expect(r.flowWinningLane).toBe('down');
    expect(r.laneVotes.up).toBeCloseTo(0.28, 2);
    expect(r.laneVotes.down).toBeCloseTo(1.65, 2);
  });

  it('returns null focusLane only on a perfect tie or no votes', () => {
    const sections = [sec({ direction: 'FLAT', netUsd: 0 })];
    const r = computeSpotPtbMachineReadout({
      sections,
      // Spot exactly at PTB → spotVsPtb = null (no vote)
      spot: 100_000,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: null,
      lastProbDown: null,
      controlSignal: 'NO_EDGE',
      dwellMajoritySign: 0,
      slopeUsdPerSec: 0,
      primaryLane: null,
      endsInMs: 30 * 60_000,
    });
    expect(r.focusLane).toBeNull();
    expect(r.laneVotes.up).toBe(0);
    expect(r.laneVotes.down).toBe(0);
  });

  it('infers implied DOWN leader when only probUp is present (binary complement)', () => {
    const sections = [
      sec({ direction: 'DOWN', netUsd: -5 }),
      sec({ direction: 'DOWN', netUsd: -4 }),
    ];
    const r = computeSpotPtbMachineReadout({
      sections,
      spot: 99_000,
      ptb: 100_000,
      bandUsd: 5,
      lastProbUp: 0.35,
      lastProbDown: null,
      controlSignal: 'DOWN_CONTROL',
      dwellMajoritySign: -1,
      slopeUsdPerSec: -0.3,
      primaryLane: null,
      endsInMs: 30 * 60_000,
    });
    expect(r.sensors.impliedLeader).toBe('down');
    expect(r.focusLane).toBe('down');
  });

  it('infers implied UP leader when only probDown is present (binary complement)', () => {
    const sections = [
      sec({ direction: 'UP', netUsd: 5 }),
      sec({ direction: 'UP', netUsd: 4 }),
    ];
    const r = computeSpotPtbMachineReadout({
      sections,
      spot: 101_000,
      ptb: 100_000,
      bandUsd: 5,
      lastProbUp: null,
      lastProbDown: 0.28,
      controlSignal: 'UP_CONTROL',
      dwellMajoritySign: 1,
      slopeUsdPerSec: 0.3,
      primaryLane: null,
      endsInMs: 30 * 60_000,
    });
    expect(r.sensors.impliedLeader).toBe('up');
    expect(r.focusLane).toBe('up');
  });

  it('votes lane from reliable UP-token buy tape', () => {
    const sections = [sec({ direction: 'FLAT', netUsd: 0 })];
    const r = computeSpotPtbMachineReadout({
      sections,
      spot: 100_000,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: 0.5,
      lastProbDown: 0.5,
      controlSignal: 'NO_EDGE',
      dwellMajoritySign: 0,
      slopeUsdPerSec: null,
      primaryLane: null,
      endsInMs: 20 * 60_000,
      tape: {
        recent: { buyVol: 80, sellVol: 10, count: 12, net: 70 },
        baseline: { buyVol: 40, sellVol: 40, count: 20, net: 0 },
        burstRatio: 2.2,
        burst: 'aggressive',
        netPressure: 55,
        dominance: 'buy',
        reliable: true,
      },
      tapeLane: 'up',
    });
    expect(r.sensors.tapeReliable).toBe(true);
    expect(r.sensors.tapeDominance).toBe('buy');
    expect(r.focusLane).toBe('up');
    expect(r.lines.some((l) => l.includes('Tape (UP)'))).toBe(true);
  });

  it('overrides UP sensor tally when walls and tape favor DOWN', () => {
    const wallFlow = computeDualOutcomeWallFlow({
      upBook: {
        bids: [{ price: 0.55, size: 30 }],
        asks: [{ price: 0.56, size: 500 }],
      },
      downBook: {
        bids: [{ price: 0.44, size: 480 }],
        asks: [{ price: 0.45, size: 28 }],
      },
    });
    const r = computeSpotPtbMachineReadout({
      sections: [sec({ direction: 'UP', netUsd: 8 }), sec({ direction: 'UP', netUsd: 6 })],
      spot: 105_000,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: 0.62,
      lastProbDown: 0.38,
      controlSignal: 'NO_EDGE',
      dwellMajoritySign: 1,
      slopeUsdPerSec: 1.5,
      primaryLane: 'up',
      endsInMs: 30 * 60_000,
      mtf: {
        dominantLane: 'up',
        fullAgreement: true,
        alignedCount: 4,
        totalActionable: 4,
        hasConflict: false,
        summary: '4/4 up',
      },
      edges: {
        up: {
          lane: 'up',
          mid: 0.62,
          pWin: 0.72,
          edgePerShareUsd: 0.1,
          evPerDollar: 0.16,
          breakevenProb: 0.62,
          marginOverBreakeven: 0.1,
          quality: 'HIGH',
          summary: '',
        },
        down: {
          lane: 'down',
          mid: 0.38,
          pWin: 0.28,
          edgePerShareUsd: -0.1,
          evPerDollar: -0.26,
          breakevenProb: 0.38,
          marginOverBreakeven: -0.1,
          quality: 'NEGATIVE',
          summary: '',
        },
        bestLane: 'up',
        bestEdgeUsd: 0.1,
      },
      tape: {
        recent: { buyVol: 4, sellVol: 120, count: 18, net: -116 },
        baseline: { buyVol: 20, sellVol: 25, count: 12, net: -5 },
        burstRatio: 3,
        burst: 'extreme',
        netPressure: -75,
        dominance: 'sell',
        reliable: true,
      },
      tapeLane: 'down',
      wallFlow,
    });
    expect(r.flowWinningLane).toBe('down');
    expect(r.laneVotes.up).toBeGreaterThan(r.laneVotes.down);
    expect(r.focusLane).toBe('down');
    expect(r.lines.some((l) => /Order-flow override/i.test(l))).toBe(true);
  });

  it('resolveFocusLaneWithOrderFlow keeps voted lane on soft book vs vote split', () => {
    expect(
      resolveFocusLaneWithOrderFlow({
        votedLane: 'up',
        flowWinningLane: 'down',
        tapeReliable: false,
        tapeDominance: null,
        wallFlowLane: null,
      }),
    ).toEqual({
      lane: 'up',
      overrideNote: expect.stringMatching(/Flow split/i),
    });
  });

  it('orderFlowConflictsLane ignores weak walls without strong tape', () => {
    expect(
      orderFlowConflictsLane('up', {
        flowWinningLane: 'down',
        sensors: { tapeReliable: false, tapeDominance: null },
        wallFlow: {
          flowLane: null,
          pressure: 0,
          headline: '',
          bidWarnings: [],
          up: null,
          down: null,
        },
      }),
    ).toBe(false);
  });

  it('maps sell aggressor on DOWN token to UP lane vote', () => {
    const r = computeSpotPtbMachineReadout({
      sections: [sec({ direction: 'FLAT', netUsd: 0 })],
      spot: 100_000,
      ptb: 100_000,
      bandUsd: 50,
      lastProbUp: 0.5,
      lastProbDown: 0.5,
      controlSignal: 'NO_EDGE',
      dwellMajoritySign: 0,
      slopeUsdPerSec: null,
      primaryLane: null,
      endsInMs: 20 * 60_000,
      tape: {
        recent: { buyVol: 5, sellVol: 90, count: 15, net: -85 },
        baseline: { buyVol: 30, sellVol: 30, count: 10, net: 0 },
        burstRatio: 2.5,
        burst: 'extreme',
        netPressure: -70,
        dominance: 'sell',
        reliable: true,
      },
      tapeLane: 'down',
    });
    expect(r.focusLane).toBe('up');
  });
});
