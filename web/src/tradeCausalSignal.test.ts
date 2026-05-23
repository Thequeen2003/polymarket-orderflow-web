import { describe, expect, it } from 'vitest';
import { buildTradeCausalBlocks, buildTradeCausalBrief } from './tradeCausalSignal';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';

function mkMachine(partial: Partial<SpotPtbMachineReadout> = {}): SpotPtbMachineReadout {
  return {
    agreementScore: 72,
    focusLane: 'down',
    laneVotes: { up: 1, down: 4 },
    regime: 'trend',
    urgency: 'med',
    probVsSpot: 'conflict',
    crossProb: 0.2,
    crossEstimate: null,
    acceleration: {
      state: 'accel-down',
      thrust: 68,
      slopeLateUsdPerSec: -0.5,
      slopeEarlyUsdPerSec: -0.1,
      direction: 'down',
      summary: 'down thrust',
    },
    mtf: null,
    overextension: null,
    endingProb: null,
    edges: null,
    flowWinningLane: 'down',
    wallFlow: {
      flowLane: 'down',
      pressure: 0.85,
      headline: 'Down wall ask 44¢',
      bidWarnings: [],
      up: { lane: 'up', bidWall: false, askWall: false, bidRatio: 0, askRatio: 0, wallAsk: null, wallBid: null },
      down: { lane: 'down', bidWall: false, askWall: true, bidRatio: 0, askRatio: 2, wallAsk: { price: 0.44, size: 5000 }, wallBid: null },
    },
    sensors: {
      spotVsPtb: 'up',
      impliedLeader: 'down',
      sectionalDrift: 'down',
      bookControl: 'down',
      microSlope: 'down',
      dwellBias: null,
      accel: 'accel-down',
      mtfDominant: null,
      overextended: null,
      tapeDominance: 'sell',
      tapeReliable: true,
      upBidWall: false,
      upAskWall: false,
      downBidWall: false,
      downAskWall: true,
    },
    lines: [],
    ...partial,
  };
}

describe('buildTradeCausalBlocks', () => {
  it('chains generator → rise → effect → signal when flow fights spot geometry', () => {
    const blocks = buildTradeCausalBlocks({
      spot: 100_200,
      ptb: 100_000,
      bandUsd: 50,
      entryLane: 'down',
      upLabel: 'Up',
      downLabel: 'Down',
      lastProbUp: 0.42,
      lastProbDown: 0.58,
      machine: mkMachine(),
      switchForecast: null,
      bandGauge: {
        mode: 'down',
        viewLabel: 'Down',
        oppositeLabel: 'Up',
        geo: 'ABOVE',
        glanceVerb: 'above',
        separation: 'CLEAR',
        edgeOk: true,
        inBand: false,
        favorableNow: false,
        activeStep: 'entry',
        spot: 100_200,
        ptb: 100_000,
        bandLo: 99_950,
        bandHi: 100_050,
        entryLine: 100_050,
        distUsd: 200,
        slopeUsdPerMin: -12,
        proj30s: 100_150,
        confirmBody: 'test',
        entryHint: 'test',
        exitHint: 'test',
      },
      wallFlow: mkMachine().wallFlow,
    });
    expect(blocks.some((b) => b.id === 'generator')).toBe(true);
    expect(blocks.some((b) => b.id === 'rise' && /below PTB|lagging|Generators favor Down/i.test(b.text))).toBe(true);
    expect(blocks.some((b) => b.id === 'signal' && /flow|book/i.test(b.text))).toBe(true);
    const brief = buildTradeCausalBrief({
      spot: 100_200,
      ptb: 100_000,
      bandUsd: 50,
      entryLane: 'down',
      upLabel: 'Up',
      downLabel: 'Down',
      lastProbUp: 0.42,
      lastProbDown: 0.58,
      machine: mkMachine(),
      switchForecast: null,
      bandGauge: null,
      wallFlow: mkMachine().wallFlow,
    });
    expect(brief).toMatch(/Signal:|flow|PTB/i);
  });
});
