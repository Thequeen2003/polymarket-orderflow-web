import { describe, expect, it } from 'vitest';

import { buildTradeDirective } from './tradeDirective';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { SwitchForecast } from './sectionalMomentum';

function mkMachine(overrides: Partial<SpotPtbMachineReadout> = {}): SpotPtbMachineReadout {
  return {
    agreementScore: 80,
    focusLane: 'up',
    laneVotes: { up: 6, down: 1 },
    regime: 'trend',
    urgency: 'med',
    probVsSpot: 'aligned',
    crossProb: 0.2,
    crossEstimate: {
      prob: 0.2,
      bias: 'stay-above',
      driftUsdPerSec: 0.5,
      volUsdPerSqrtSec: 2,
      horizonSec: 600,
      distanceUsd: 500,
      confidence: 'high',
      summary: 'high prob hold',
    },
    acceleration: {
      state: 'accel-up',
      thrust: 70,
      slopeLateUsdPerSec: 1.2,
      slopeEarlyUsdPerSec: 0.4,
      direction: 'up',
      summary: 'accelerating up',
    },
    mtf: null,
    overextension: null,
    endingProb: null,
    edges: null,
    flowWinningLane: 'up',
    wallFlow: null,
    lines: ['Machine agreement 80%'],
    sensors: {
      spotVsPtb: 'up',
      impliedLeader: 'up',
      sectionalDrift: 'up',
      bookControl: 'up',
      microSlope: 'up',
      dwellBias: 'up',
      accel: 'accel-up',
      mtfDominant: null,
      overextended: null,
      tapeDominance: null,
      tapeReliable: false,
      upBidWall: false,
      upAskWall: false,
      downBidWall: false,
      downAskWall: false,
      ...(overrides.sensors ?? {}),
    },
    ...overrides,
  };
}

function mkForecast(overrides: Partial<SwitchForecast> = {}): SwitchForecast {
  return {
    status: 'GO_IN',
    lane: 'up',
    driftLane: 'up',
    incomingLane: null,
    confidence: 'HIGH',
    headline: 'GO IN UP',
    reason: 'sectional drift up',
    evidence: [],
    etaSec: null,
    ...overrides,
  };
}

describe('buildTradeDirective', () => {
  it('STAND_DOWN when no machine readout', () => {
    const d = buildTradeDirective({
      machine: null,
      forecast: null,
      currentPositionLane: null,
    });
    expect(d.action).toBe('STAND_DOWN');
  });

  it('blocks INITIATE when focus lane fights tape/book flow', () => {
    const d = buildTradeDirective({
      machine: mkMachine({
        focusLane: 'up',
        flowWinningLane: 'down',
        agreementScore: 72,
        sensors: {
          spotVsPtb: 'up',
          impliedLeader: 'up',
          sectionalDrift: 'up',
          bookControl: 'up',
          microSlope: 'up',
          dwellBias: 'up',
          accel: 'accel-up',
          mtfDominant: null,
          overextended: null,
          tapeDominance: 'sell',
          tapeReliable: true,
          upBidWall: false,
          upAskWall: false,
          downBidWall: true,
          downAskWall: false,
        },
        wallFlow: { flowLane: 'down', pressure: 2, headline: 'Walls → DOWN', bidWarnings: [], askWarnings: [] },
      }),
      forecast: null,
      currentPositionLane: null,
    });
    expect(d.action).toBe('STAND_DOWN');
    expect(d.headline).toMatch(/FLOW DOWN/i);
  });

  it('INITIATE when flat and stack agrees strongly', () => {
    const d = buildTradeDirective({
      machine: mkMachine(),
      forecast: mkForecast(),
      currentPositionLane: null,
      upLabel: 'BTC UP',
      downLabel: 'BTC DOWN',
    });
    expect(d.action).toBe('INITIATE');
    expect(d.lane).toBe('up');
    expect(d.recommendedSize).toBeGreaterThan(0.3);
    expect(d.headline).toContain('INITIATE');
  });

  it('STAND_DOWN in chop regime with weak agreement', () => {
    const d = buildTradeDirective({
      machine: mkMachine({ regime: 'chop', agreementScore: 36 }),
      forecast: mkForecast(),
      currentPositionLane: null,
    });
    expect(d.action).toBe('STAND_DOWN');
    expect(d.reason).toMatch(/chop/i);
  });

  it('STAND_DOWN when prob vs spot conflicts AND agreement is very weak', () => {
    const d = buildTradeDirective({
      machine: mkMachine({ probVsSpot: 'conflict', agreementScore: 36 }),
      forecast: mkForecast(),
      currentPositionLane: null,
    });
    expect(d.action).toBe('STAND_DOWN');
  });

  it('PROBE (LOW conviction INITIATE) when agreement is 45–51 with non-negative edge', () => {
    const d = buildTradeDirective({
      machine: mkMachine({ agreementScore: 48, regime: 'grind' }),
      forecast: mkForecast({ status: 'WAIT' }),
      currentPositionLane: null,
    });
    expect(d.action).toBe('INITIATE');
    expect(d.confidence).toBe('LOW');
    expect(d.headline).toMatch(/PROBE/);
  });

  it('PROBE DOWN in chop when agreement is 48–51 (chop no longer blocks all probes)', () => {
    const d = buildTradeDirective({
      machine: mkMachine({
        focusLane: 'down',
        agreementScore: 49,
        regime: 'chop',
        laneVotes: { up: 2, down: 6 },
        sensors: {
          spotVsPtb: 'down',
          impliedLeader: 'down',
          sectionalDrift: 'down',
          bookControl: 'down',
          microSlope: 'down',
          dwellBias: 'down',
          accel: 'idle',
          mtfDominant: null,
          overextended: null,
        },
      }),
      forecast: mkForecast({ status: 'WAIT' }),
      currentPositionLane: null,
      downLabel: 'BTC Down',
    });
    expect(d.action).toBe('INITIATE');
    expect(d.lane).toBe('down');
    expect(d.headline).toMatch(/PROBE/i);
    expect(d.headline).toMatch(/BTC Down|DOWN/i);
    expect(d.confidence).toBe('LOW');
  });

  it('INITIATE fires even when forecaster is on WAIT (sensor consensus carries the call)', () => {
    const d = buildTradeDirective({
      machine: mkMachine({ agreementScore: 70 }),
      forecast: mkForecast({ status: 'WAIT' }),
      currentPositionLane: null,
    });
    expect(d.action).toBe('INITIATE');
    expect(d.lane).toBe('up');
  });

  it('sets laneOutcomeLabel from market labels for TP/SL scoping', () => {
    const d = buildTradeDirective({
      machine: mkMachine({ agreementScore: 70 }),
      forecast: mkForecast({ status: 'WAIT' }),
      currentPositionLane: null,
      upLabel: 'BTC Up',
      downLabel: 'BTC Down',
    });
    expect(d.laneOutcomeLabel).toBe('BTC Up');
  });

  it('HOLD when in position aligned with consensus', () => {
    const d = buildTradeDirective({
      machine: mkMachine({ agreementScore: 70 }),
      forecast: mkForecast({ status: 'STAY_IN' }),
      currentPositionLane: 'up',
    });
    expect(d.action).toBe('HOLD');
    expect(d.lane).toBe('up');
  });

  it('ADD when aligned with strong consensus + accel + GO_IN', () => {
    const d = buildTradeDirective({
      machine: mkMachine({ agreementScore: 82 }),
      forecast: mkForecast({ status: 'GO_IN' }),
      currentPositionLane: 'up',
    });
    expect(d.action).toBe('ADD');
    expect(d.recommendedSize).toBeGreaterThan(0);
  });

  it('TRIM on reversing acceleration while in position', () => {
    const d = buildTradeDirective({
      machine: mkMachine({
        acceleration: {
          state: 'reversing',
          thrust: 40,
          slopeLateUsdPerSec: -0.5,
          slopeEarlyUsdPerSec: 1,
          direction: 'down',
          summary: 'reversing',
        },
      }),
      forecast: mkForecast({ status: 'STAY_IN' }),
      currentPositionLane: 'up',
    });
    expect(d.action).toBe('TRIM');
    expect(d.defensive).toBe(true);
  });

  it('FLIP when held opposite to high-agreement consensus', () => {
    const d = buildTradeDirective({
      machine: mkMachine({ focusLane: 'down', agreementScore: 78, crossProb: 0.6 }),
      forecast: mkForecast({ status: 'SWITCH_INCOMING', lane: 'up', incomingLane: 'down' }),
      currentPositionLane: 'up',
    });
    expect(d.action).toBe('FLIP');
    expect(d.lane).toBe('down');
    // Early sectional switch — do not pulse ACT NOW on the new leg while the held exit is still open.
    expect(d.urgency).toBe('soon');
    expect(d.headline.toLowerCase()).toContain('exit');
    expect(d.headline.toLowerCase()).toContain('first');
  });

  it('FLIP with GO_IN can use urgency now at very high agreement', () => {
    const d = buildTradeDirective({
      machine: mkMachine({ focusLane: 'down', agreementScore: 80, crossProb: 0.6 }),
      forecast: mkForecast({ status: 'GO_IN', lane: 'down', incomingLane: 'down' }),
      currentPositionLane: 'up',
    });
    expect(d.action).toBe('FLIP');
    expect(d.urgency).toBe('now');
  });

  it('EXIT in settlement when held opposite + cross likely', () => {
    const d = buildTradeDirective({
      machine: mkMachine({ urgency: 'settlement', focusLane: 'down', crossProb: 0.7 }),
      forecast: mkForecast({ status: 'EXIT', lane: 'up' }),
      currentPositionLane: 'up',
    });
    expect(d.action).toBe('EXIT');
    expect(d.urgency).toBe('now');
  });

  it('HOLD in settlement when in position aligned', () => {
    const d = buildTradeDirective({
      machine: mkMachine({ urgency: 'settlement' }),
      forecast: mkForecast({ status: 'STAY_IN' }),
      currentPositionLane: 'up',
    });
    expect(d.action).toBe('HOLD');
    expect(d.recommendedSize).toBe(0);
  });

  it('STAND_DOWN settlement when flat', () => {
    const d = buildTradeDirective({
      machine: mkMachine({ urgency: 'settlement' }),
      forecast: mkForecast(),
      currentPositionLane: null,
    });
    expect(d.action).toBe('STAND_DOWN');
    expect(d.headline).toMatch(/SETTLEMENT/);
  });

  it('STAND_DOWN with WATCH OVEREXTENDED only when agreement is below probe floor', () => {
    const d = buildTradeDirective({
      machine: mkMachine({
        agreementScore: 48,
        overextension: {
          state: 'overextended',
          recentMoveUsd: 80,
          baselineMedianUsd: 20,
          ratio: 4,
          severity: 90,
          direction: 'up',
          summary: 'overextended',
        },
      }),
      forecast: mkForecast(),
      currentPositionLane: null,
    });
    expect(d.action).toBe('STAND_DOWN');
    expect(d.headline).toMatch(/OVEREXTENDED/);
  });

  it('INITIATE through overextension when agreement is strong (≥70) — confirmed trend', () => {
    const d = buildTradeDirective({
      machine: mkMachine({
        agreementScore: 75,
        overextension: {
          state: 'overextended',
          recentMoveUsd: 80,
          baselineMedianUsd: 20,
          ratio: 4,
          severity: 90,
          direction: 'up',
          summary: 'overextended',
        },
      }),
      forecast: mkForecast(),
      currentPositionLane: null,
    });
    expect(d.action).toBe('INITIATE');
  });

  it('STAND_DOWN with NEGATIVE EV only when conviction is meh', () => {
    const d = buildTradeDirective({
      machine: mkMachine({
        agreementScore: 48,
        edges: {
          up: {
            lane: 'up',
            mid: 0.78,
            pWin: 0.6,
            edgePerShareUsd: -0.18,
            evPerDollar: -0.23,
            breakevenProb: 0.78,
            marginOverBreakeven: -0.18,
            quality: 'NEGATIVE',
            summary: 'neg edge',
          },
          down: null,
          bestLane: null,
          bestEdgeUsd: 0,
        },
      }),
      forecast: mkForecast(),
      currentPositionLane: null,
    });
    expect(d.action).toBe('STAND_DOWN');
    expect(d.headline).toMatch(/NEGATIVE EV/);
    expect(d.edgePerShareUsd).toBeCloseTo(-0.18, 2);
  });

  it('INITIATE includes edge $/share in evidence', () => {
    const d = buildTradeDirective({
      machine: mkMachine({
        agreementScore: 75,
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
            summary: 'edge',
          },
          down: null,
          bestLane: 'up',
          bestEdgeUsd: 0.15,
        },
      }),
      forecast: mkForecast(),
      currentPositionLane: null,
    });
    expect(d.action).toBe('INITIATE');
    expect(d.edgePerShareUsd).toBeCloseTo(0.15, 2);
    expect(d.laneMid).toBeCloseTo(0.55, 2);
    expect(d.evidence.some((e) => e.includes('Edge'))).toBe(true);
  });

  it('size shrinks in chop regime', () => {
    const trend = buildTradeDirective({
      machine: mkMachine({ regime: 'trend' }),
      forecast: mkForecast(),
      currentPositionLane: null,
    });
    const grind = buildTradeDirective({
      machine: mkMachine({ regime: 'grind' }),
      forecast: mkForecast(),
      currentPositionLane: null,
    });
    expect(grind.recommendedSize).toBeLessThan(trend.recommendedSize + 1e-9);
  });
});
