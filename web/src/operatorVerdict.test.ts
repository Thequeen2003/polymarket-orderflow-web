import { describe, expect, it } from 'vitest';
import { buildOperatorVerdict } from './operatorVerdict';
import type { TradeDirective } from './tradeDirective';
import type { TradeLevels } from './tradeLevels';
import type { DirectiveStability } from './directiveStability';
import type { DirectiveDiscrepancy } from './directiveDiscrepancyGuard';
import type { ReEntryGuardCheck } from './reEntryGuard';
import type { NoTradeScore } from './noTradeScore';

function mkDirective(overrides: Partial<TradeDirective> = {}): TradeDirective {
  return {
    action: 'INITIATE',
    lane: 'up',
    urgency: 'soon',
    recommendedSize: 0.5,
    headline: 'INITIATE UP',
    reason: 'Spot rising + PTB cross likely.',
    evidence: ['MTF 3/3 up', 'tape buying', 'edge HIGH'],
    confidence: 'HIGH',
    defensive: false,
    edgePerShareUsd: 0.12,
    laneMid: 0.62,
    laneWinProb: 0.74,
    ...overrides,
  };
}

function mkLevels(overrides: Partial<TradeLevels> = {}): TradeLevels {
  return {
    lane: 'up',
    entry: 0.62,
    takeProfit: 0.74,
    stopLoss: 0.55,
    takeProfitGain: 0.12,
    stopLossLoss: 0.07,
    rrRatio: 1.71,
    horizonSec: 600,
    summary: 'TP 0.74 / SL 0.55 / R:R 1.71',
    collapsed: false,
    ...overrides,
  };
}

function mkStability(overrides: Partial<DirectiveStability> = {}): DirectiveStability {
  return {
    tier: 'stable',
    msSinceChange: 90_000,
    flipsLastMin: 0,
    current: { ts: 0, action: 'INITIATE', lane: 'up' },
    previous: null,
    history: [],
    warnFresh: false,
    whipsaw: false,
    summary: 'stable for 90s',
    ...overrides,
  };
}

function mkDiscrepancy(overrides: Partial<DirectiveDiscrepancy> = {}): DirectiveDiscrepancy {
  return {
    warnings: [],
    score: 0,
    shouldBlock: false,
    any: false,
    ...overrides,
  };
}

describe('buildOperatorVerdict', () => {
  it('GO_LONG with concrete TP/SL when directive is INITIATE up', () => {
    const v = buildOperatorVerdict({ directive: mkDirective(), levels: mkLevels() });
    expect(v.state).toBe('GO_LONG');
    expect(v.color).toBe('green');
    expect(v.bigVerb).toBe('ENTER UP');
    expect(v.headline).toContain('TP 0.74');
    expect(v.headline).toContain('SL 0.55');
    expect(v.headline).toContain('R:R 1.71');
    expect(v.confidence).toBe('HIGH');
    expect(v.isStandDown).toBe(false);
    expect(v.blockers).toEqual([]);
  });

  it('GO_SHORT for INITIATE down with TP/SL in headline', () => {
    const v = buildOperatorVerdict({
      directive: mkDirective({ lane: 'down', headline: 'INITIATE DOWN' }),
      levels: mkLevels({
        lane: 'down',
        entry: 0.4,
        takeProfit: 0.52,
        stopLoss: 0.33,
        takeProfitGain: 0.12,
        stopLossLoss: 0.07,
        rrRatio: 1.71,
      }),
    });
    expect(v.state).toBe('GO_SHORT');
    expect(v.bigVerb).toBe('ENTER DOWN');
    expect(v.headline).toContain('TP 0.52');
    expect(v.headline).toContain('SL 0.33');
    expect(v.headline).toContain('R:R 1.71');
  });

  it('INITIATE down + mid but no levels yet: headline does not fake settlement window', () => {
    const v = buildOperatorVerdict({
      directive: mkDirective({ lane: 'down', headline: 'INITIATE DOWN' }),
      levels: null,
    });
    expect(v.state).toBe('GO_SHORT');
    expect(v.headline).toMatch(/TP\/SL row still loading/i);
    expect(v.headline.toLowerCase()).not.toContain('settlement window');
  });

  it('ADD uses ADD verb', () => {
    const v = buildOperatorVerdict({
      directive: mkDirective({ action: 'ADD', headline: 'ADD UP' }),
      levels: mkLevels(),
    });
    expect(v.state).toBe('GO_LONG');
    expect(v.bigVerb).toBe('ADD UP');
  });

  it('forces STAND_DOWN when noTradeScore tier is RED and score is severe', () => {
    const noTrade: NoTradeScore = { score: 97, tier: 'RED', contributions: [], summary: 'red' };
    const v = buildOperatorVerdict({
      directive: mkDirective(),
      levels: mkLevels(),
      noTradeScore: noTrade,
    });
    expect(v.state).toBe('STAND_DOWN');
    expect(v.isStandDown).toBe(true);
    expect(v.bigVerb).toBe("DON'T TRADE");
    expect(v.primaryBlocker).toContain('No-Trade 97');
  });

  it('does not STAND_DOWN on elevated no-trade when below severity cutoff', () => {
    const noTrade: NoTradeScore = { score: 80, tier: 'RED', contributions: [], summary: 'red' };
    const v = buildOperatorVerdict({
      directive: mkDirective(),
      levels: mkLevels(),
      noTradeScore: noTrade,
    });
    expect(v.state).toBe('GO_LONG');
    expect(v.isStandDown).toBe(false);
  });

  it('forces STAND_DOWN on whipsaw when directive is actionable', () => {
    const v = buildOperatorVerdict({
      directive: mkDirective(),
      levels: mkLevels(),
      stability: mkStability({ tier: 'whipsaw', flipsLastMin: 12 }),
    });
    expect(v.state).toBe('STAND_DOWN');
    expect(v.primaryBlocker).toContain('whipsaw');
  });

  it('whipsaw does NOT force stand down when flip rate is elevated but below cutoff', () => {
    const v = buildOperatorVerdict({
      directive: mkDirective(),
      levels: mkLevels(),
      stability: mkStability({ tier: 'whipsaw', flipsLastMin: 8 }),
    });
    expect(v.state).toBe('GO_LONG');
    expect(v.isStandDown).toBe(false);
  });

  it('whipsaw does NOT force stand down when directive is HOLD', () => {
    const v = buildOperatorVerdict({
      directive: mkDirective({ action: 'HOLD' }),
      stability: mkStability({ tier: 'whipsaw', flipsLastMin: 5 }),
    });
    expect(v.state).toBe('HOLD');
  });

  it('forces STAND_DOWN on shouldBlock discrepancy', () => {
    const v = buildOperatorVerdict({
      directive: mkDirective(),
      discrepancy: mkDiscrepancy({ shouldBlock: true, any: true, score: 95 }),
    });
    expect(v.state).toBe('STAND_DOWN');
    expect(v.primaryBlocker).toContain('disagree');
  });

  it('forces STAND_DOWN when on cooldown for the requested lane', () => {
    const reEntry: ReEntryGuardCheck = {
      onCooldown: true,
      msRemaining: 12_000,
      lane: 'up',
      reason: 'cool-down 12s',
    };
    const v = buildOperatorVerdict({
      directive: mkDirective({ lane: 'up' }),
      reEntry,
    });
    expect(v.state).toBe('STAND_DOWN');
    expect(v.primaryBlocker).toMatch(/cool-down/);
  });

  it('cooldown for the OTHER lane does NOT force stand down', () => {
    // Directive wants UP but cooldown is on DOWN — fine.
    const reEntry: ReEntryGuardCheck = {
      onCooldown: true,
      msRemaining: 12_000,
      lane: 'down',
      reason: 'cool-down 12s',
    };
    const v = buildOperatorVerdict({
      directive: mkDirective({ lane: 'up' }),
      levels: mkLevels(),
      reEntry,
    });
    expect(v.state).toBe('GO_LONG');
  });

  it('EXIT directive maps to EXIT_NOW with red color', () => {
    const v = buildOperatorVerdict({
      directive: mkDirective({ action: 'EXIT', headline: 'EXIT', defensive: true, lane: 'up' }),
    });
    expect(v.state).toBe('EXIT_NOW');
    expect(v.color).toBe('red');
    expect(v.bigVerb).toBe('EXIT UP');
  });

  it('FLIP directive maps to EXIT_NOW with FLIP verb', () => {
    const v = buildOperatorVerdict({
      directive: mkDirective({ action: 'FLIP', lane: 'down', headline: 'FLIP DOWN' }),
    });
    expect(v.state).toBe('EXIT_NOW');
    expect(v.bigVerb).toContain('FLIP');
    expect(v.bigVerb).toContain('DOWN');
  });

  it('FLIP headline numbers exit-then-enter using held vs target outcome labels', () => {
    const v = buildOperatorVerdict({
      directive: mkDirective({
        action: 'FLIP',
        lane: 'down',
        laneMid: 0.41,
        flipHeldOutcomeLabel: 'BTC UP',
        laneOutcomeLabel: 'BTC DOWN',
        headline: 'FLIP',
      }),
    });
    expect(v.headline).toMatch(/1\).*BTC UP/i);
    expect(v.headline).toMatch(/2\).*BTC DOWN/i);
  });

  it('TRIM directive maps to EXIT_NOW with amber color', () => {
    const v = buildOperatorVerdict({
      directive: mkDirective({ action: 'TRIM', lane: 'up', headline: 'TRIM' }),
    });
    expect(v.state).toBe('EXIT_NOW');
    expect(v.color).toBe('amber');
    expect(v.bigVerb).toBe('TRIM');
  });

  it('HOLD directive returns HOLD state', () => {
    const v = buildOperatorVerdict({ directive: mkDirective({ action: 'HOLD' }) });
    expect(v.state).toBe('HOLD');
    expect(v.bigVerb).toContain('HOLD');
    expect(v.color).toBe('blue');
  });

  it('STAND_DOWN directive carries through', () => {
    const v = buildOperatorVerdict({
      directive: mkDirective({ action: 'STAND_DOWN', headline: 'WAIT', lane: null }),
    });
    expect(v.state).toBe('STAND_DOWN');
    expect(v.isStandDown).toBe(true);
  });

  it('null directive yields STAND_DOWN', () => {
    const v = buildOperatorVerdict({ directive: null });
    expect(v.state).toBe('STAND_DOWN');
    expect(v.bigVerb).toBe('No signal yet');
  });

  it('collapses TP/SL into a settlement-window message when levels.collapsed', () => {
    const v = buildOperatorVerdict({
      directive: mkDirective(),
      levels: mkLevels({ collapsed: true, summary: 'Settlement window' }),
    });
    expect(v.state).toBe('GO_LONG');
    expect(v.headline.toLowerCase()).toContain('settlement');
  });

  it('lists multiple blockers when more than one fires', () => {
    const v = buildOperatorVerdict({
      directive: mkDirective(),
      stability: mkStability({ tier: 'whipsaw', flipsLastMin: 12 }),
      discrepancy: mkDiscrepancy({ shouldBlock: true, any: true, score: 95 }),
    });
    expect(v.state).toBe('STAND_DOWN');
    expect(v.blockers.length).toBeGreaterThanOrEqual(2);
    expect(v.reason).toMatch(/blockers/);
  });

  it('downgrades confidence when directive is forming', () => {
    const v = buildOperatorVerdict({
      directive: mkDirective({ confidence: 'HIGH' }),
      levels: mkLevels(),
      stability: mkStability({ tier: 'forming', msSinceChange: 2_000 }),
    });
    expect(v.confidence).not.toBe('HIGH');
  });

  it('cross-engine lane mismatch blocks only LOW-conviction INITIATE', () => {
    const blocked = buildOperatorVerdict({
      directive: mkDirective({ action: 'INITIATE', lane: 'up', confidence: 'LOW' }),
      levels: mkLevels(),
      crossEngineLaneConflict: true,
    });
    expect(blocked.state).toBe('STAND_DOWN');
    expect(blocked.blockers.join(' ')).toMatch(/Dual lane mismatch/i);

    const allowed = buildOperatorVerdict({
      directive: mkDirective({ action: 'INITIATE', lane: 'up', confidence: 'HIGH' }),
      levels: mkLevels(),
      crossEngineLaneConflict: true,
    });
    expect(allowed.state).toBe('GO_LONG');

    const add = buildOperatorVerdict({
      directive: mkDirective({ action: 'ADD', lane: 'up' }),
      crossEngineLaneConflict: true,
    });
    expect(add.state).toBe('GO_LONG');
  });

  it('cross-engine lane mismatch does not block HOLD / EXIT / TRIM', () => {
    expect(
      buildOperatorVerdict({ directive: mkDirective({ action: 'HOLD' }), crossEngineLaneConflict: true }).state,
    ).toBe('HOLD');
    expect(
      buildOperatorVerdict({
        directive: mkDirective({ action: 'EXIT', lane: 'up', headline: 'EXIT' }),
        crossEngineLaneConflict: true,
      }).state,
    ).toBe('EXIT_NOW');
  });

  it('explains Cross-check STAND_DOWN with Spot vs Dual lanes when provided', () => {
    const v = buildOperatorVerdict({
      directive: mkDirective({ action: 'INITIATE', lane: 'down', headline: 'INITIATE DOWN', confidence: 'LOW' }),
      levels: mkLevels({ lane: 'down', entry: 0.4, takeProfit: 0.52, stopLoss: 0.33, rrRatio: 1.4 }),
      crossEngineLaneConflict: true,
      crossCheckSpotLane: 'up',
      crossCheckDualLane: 'down',
    });
    expect(v.state).toBe('STAND_DOWN');
    expect(v.headline).toMatch(/Spot\/Dual disagree/i);
    expect(v.headline).toMatch(/Spot strip → UP/i);
    expect(v.headline).toMatch(/Dual implied → DOWN/i);
  });
});
