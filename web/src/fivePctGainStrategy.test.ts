import { describe, expect, it } from 'vitest';
import {
  classifyEntryZone01,
  computeFivePctBracketLevels,
  evaluateFivePctGainStrategy,
  ENTRY_MIN_01,
  ENTRY_MAX_01,
} from './fivePctGainStrategy';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { TapeVelocity } from './tapeVelocity';
import type { TradeDirective } from './tradeDirective';

function mkMachine(partial: Partial<SpotPtbMachineReadout> = {}): SpotPtbMachineReadout {
  return {
    agreementScore: 72,
    focusLane: 'up',
    laneVotes: { up: 4, down: 1 },
    regime: 'trend',
    urgency: 'med',
    probVsSpot: 'aligned',
    crossProb: 0.62,
    crossEstimate: null,
    acceleration: {
      state: 'accel-up',
      thrust: 68,
      slopeLateUsdPerSec: 0.5,
      slopeEarlyUsdPerSec: 0.1,
      direction: 'up',
      summary: 'accel up',
    },
    mtf: null,
    overextension: {
      state: 'normal',
      recentMoveUsd: 40,
      baselineMedianUsd: 50,
      ratio: 0.8,
      severity: 20,
      direction: 'up',
      summary: 'normal',
    },
    endingProb: null,
    edges: null,
    flowWinningLane: 'up',
    wallFlow: {
      up: {
        lane: 'up',
        askWall: false,
        bidWall: false,
        askRatio: 1.1,
        bidRatio: 1,
        wallAsk: { price: 0.62, size: 80 },
        wallBid: { price: 0.58, size: 100 },
      },
      down: null,
      flowLane: 'up',
      pressure: 24,
      headline: 'UP flow',
      bidWarnings: [],
    },
    sensors: {
      spotVsPtb: 'up',
      impliedLeader: 'up',
      sectionalDrift: 'up',
      bookControl: 'up',
      microSlope: 'up',
      dwellBias: 'up',
      accel: 'accel-up',
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
    ...partial,
  };
}

const buyTape: TapeVelocity = {
  recent: { buyVol: 400, sellVol: 120, count: 12, net: 280 },
  baseline: { buyVol: 200, sellVol: 180, count: 40, net: 20 },
  burstRatio: 1.2,
  burst: 'normal',
  netPressure: 42,
  dominance: 'buy',
  reliable: true,
  summary: 'buyers in control',
};

const initiateUp: TradeDirective = {
  action: 'INITIATE',
  lane: 'up',
  urgency: 'now',
  recommendedSize: 0.4,
  headline: 'INITIATE UP',
  reason: 'r',
  evidence: [],
  confidence: 'HIGH',
  defensive: false,
  edgePerShareUsd: 0.05,
  laneMid: 0.6,
  laneWinProb: 0.58,
};

describe('fivePctGainStrategy', () => {
  it('classifies entry zones', () => {
    expect(classifyEntryZone01(0.5)).toBe('value');
    expect(classifyEntryZone01(0.72)).toBe('momentum');
    expect(classifyEntryZone01(0.88)).toBe('late');
    expect(classifyEntryZone01(0.4)).toBe('out_of_band');
  });

  it('targets ~+5% and protective stop from 60¢ entry', () => {
    const b = computeFivePctBracketLevels(0.6);
    expect(b.targetExit01).toBeCloseTo(0.63, 3);
    expect(b.stopLoss01).toBeCloseTo(0.54, 3);
    expect(b.riskReward).toBeGreaterThan(0);
  });

  it('rejects entry below 48¢', () => {
    const r = evaluateFivePctGainStrategy({
      lane: 'up',
      entry01: 0.42,
      directive: initiateUp,
      machine: mkMachine(),
      tape: buyTape,
      wallFlow: mkMachine().wallFlow,
      slug: 'btc-updown-5m-123',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/48–93/);
  });

  it('emits signal when rules align at 60¢', () => {
    const r = evaluateFivePctGainStrategy({
      lane: 'up',
      entry01: 0.6,
      directive: initiateUp,
      machine: mkMachine(),
      tape: buyTape,
      wallFlow: mkMachine().wallFlow,
      slug: 'btc-updown-5m-123',
      upLabel: 'BTC Up',
      downLabel: 'BTC Down',
    });
    expect(r.ok).toBe(true);
    expect(r.signal?.entryCents).toBe(60);
    expect(r.signal?.targetExitCents).toBe(63);
    expect(r.signal?.stopLossCents).toBe(54);
    expect(r.signal?.direction).toBe('UP');
    expect(r.signal?.market).toMatch(/BTC.*5m/i);
  });

  it('rejects chop regime', () => {
    const r = evaluateFivePctGainStrategy({
      lane: 'up',
      entry01: 0.6,
      directive: initiateUp,
      machine: mkMachine({ regime: 'chop' }),
      tape: buyTape,
      wallFlow: mkMachine().wallFlow,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Chop/i);
  });

  it('respects entry band constants', () => {
    expect(ENTRY_MIN_01).toBe(0.48);
    expect(ENTRY_MAX_01).toBe(0.93);
  });
});
