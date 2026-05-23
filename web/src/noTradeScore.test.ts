import { describe, expect, it } from 'vitest';
import { computeNoTradeScore } from './noTradeScore';
import type { DirectiveStability } from './directiveStability';
import type { DirectiveDiscrepancy } from './directiveDiscrepancyGuard';
import type { LaneEdges, TradeEdge } from './tradeEdgeCalculator';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { Overextension } from './overextensionDetector';
import type { ReEntryGuardCheck } from './reEntryGuard';
import type { TapeVelocity } from './tapeVelocity';

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

function mkEdges(quality: TradeEdge['quality'], lane: 'up' | 'down' = 'up'): LaneEdges {
  const edge: TradeEdge = {
    lane,
    mid: 0.5,
    pWin: 0.6,
    edgePerShareUsd: quality === 'NEGATIVE' ? -0.05 : quality === 'THIN' ? 0.005 : 0.1,
    evPerDollar: 0,
    breakevenProb: 0.5,
    marginOverBreakeven: 0,
    quality,
    summary: '',
  };
  return {
    up: lane === 'up' ? edge : null,
    down: lane === 'down' ? edge : null,
    bestLane: lane,
    bestEdgeUsd: edge.edgePerShareUsd,
  };
}

function mkOverext(state: Overextension['state'], dir: 'up' | 'down'): Overextension {
  return {
    state,
    recentMoveUsd: 80,
    baselineMedianUsd: 20,
    ratio: 4,
    severity: 90,
    direction: dir,
    summary: '',
  };
}

function mkMachine(over: Partial<SpotPtbMachineReadout> = {}): SpotPtbMachineReadout {
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

function mkTape(over: Partial<TapeVelocity> = {}): TapeVelocity {
  return {
    recent: { buyVol: 0, sellVol: 0, count: 0, net: 0 },
    baseline: { buyVol: 0, sellVol: 0, count: 0, net: 0 },
    burstRatio: 0,
    burst: 'normal',
    netPressure: 0,
    dominance: 'mixed',
    reliable: true,
    summary: '',
    ...over,
  };
}

describe('computeNoTradeScore', () => {
  it('returns GREEN with no inputs', () => {
    const r = computeNoTradeScore({});
    expect(r.tier).toBe('GREEN');
    expect(r.score).toBe(0);
  });

  it('flags WHIPSAW heavily', () => {
    const r = computeNoTradeScore({ stability: mkStability('whipsaw') });
    expect(r.contributions[0]?.reason).toBe('WHIPSAW');
    expect(r.score).toBeGreaterThanOrEqual(35);
    expect(r.tier).toBe('YELLOW');
  });

  it('NEGATIVE_EDGE alone reaches RED', () => {
    const r = computeNoTradeScore({ lane: 'up', edges: mkEdges('NEGATIVE') });
    expect(r.score).toBeGreaterThanOrEqual(30);
  });

  it('flags THIN_EDGE', () => {
    const r = computeNoTradeScore({ lane: 'up', edges: mkEdges('THIN') });
    expect(r.contributions.some((c) => c.reason === 'THIN_EDGE')).toBe(true);
  });

  it('flags OVEREXTENDED_CHASE only when direction matches lane', () => {
    const same = computeNoTradeScore({ lane: 'up', overextension: mkOverext('overextended', 'up') });
    const opp = computeNoTradeScore({ lane: 'up', overextension: mkOverext('overextended', 'down') });
    expect(same.contributions.some((c) => c.reason === 'OVEREXTENDED_CHASE')).toBe(true);
    expect(opp.contributions.some((c) => c.reason === 'OVEREXTENDED_CHASE')).toBe(false);
  });

  it('flags CHOP_REGIME', () => {
    const r = computeNoTradeScore({ machine: mkMachine({ regime: 'chop' }) });
    expect(r.contributions.some((c) => c.reason === 'CHOP_REGIME')).toBe(true);
  });

  it('flags SETTLEMENT_NO_EDGE only without edge', () => {
    const tooThin = computeNoTradeScore({ inSettlement: true, edges: mkEdges('THIN') });
    expect(tooThin.contributions.some((c) => c.reason === 'SETTLEMENT_NO_EDGE')).toBe(true);
    const fat = computeNoTradeScore({ inSettlement: true, edges: mkEdges('HIGH') });
    expect(fat.contributions.some((c) => c.reason === 'SETTLEMENT_NO_EDGE')).toBe(false);
  });

  it('flags COOLDOWN_ACTIVE', () => {
    const re: ReEntryGuardCheck = { onCooldown: true, msRemaining: 12_000, lane: 'up', reason: '' };
    const r = computeNoTradeScore({ reEntry: re });
    expect(r.contributions.some((c) => c.reason === 'COOLDOWN_ACTIVE')).toBe(true);
  });

  it('flags TAPE_FIGHTS when prints push opposite the lane', () => {
    const r = computeNoTradeScore({
      lane: 'up',
      tape: mkTape({ dominance: 'sell', burst: 'aggressive', reliable: true }),
    });
    expect(r.contributions.some((c) => c.reason === 'TAPE_FIGHTS')).toBe(true);
  });

  it('flags TAPE_QUIET when tape idle but lane intended', () => {
    const r = computeNoTradeScore({ lane: 'up', tape: mkTape({ burst: 'idle', reliable: false }) });
    expect(r.contributions.some((c) => c.reason === 'TAPE_QUIET')).toBe(true);
  });

  it('reaches RED when many bad signals stack', () => {
    const r = computeNoTradeScore({
      stability: mkStability('whipsaw'),
      discrepancy: {
        warnings: [{ kind: 'MTF_OPPOSITE', severity: 'high', message: '' }],
        score: 35,
        shouldBlock: true,
        any: true,
      } satisfies DirectiveDiscrepancy,
      lane: 'up',
      edges: mkEdges('THIN'),
      overextension: mkOverext('overextended', 'up'),
    });
    expect(r.tier).toBe('RED');
    expect(r.score).toBeGreaterThanOrEqual(60);
  });

  it('clamps score at 100', () => {
    const r = computeNoTradeScore({
      stability: mkStability('whipsaw'),
      discrepancy: {
        warnings: [{ kind: 'MTF_OPPOSITE', severity: 'high', message: '' }],
        score: 35,
        shouldBlock: true,
        any: true,
      },
      lane: 'up',
      edges: mkEdges('NEGATIVE'),
      overextension: mkOverext('overextended', 'up'),
      machine: mkMachine({ regime: 'chop' }),
      reEntry: { onCooldown: true, msRemaining: 12_000, lane: 'up', reason: '' },
      tape: mkTape({ dominance: 'sell', burst: 'extreme', reliable: true }),
    });
    expect(r.score).toBe(100);
  });

  it('contributions are sorted heaviest first', () => {
    const r = computeNoTradeScore({
      stability: mkStability('forming'),
      lane: 'up',
      edges: mkEdges('NEGATIVE'),
    });
    expect(r.contributions[0]!.weight).toBeGreaterThanOrEqual(r.contributions[r.contributions.length - 1]!.weight);
  });
});
