import { describe, expect, it } from 'vitest';
import { buildTraderDiscipline } from './traderDiscipline';
import type { OperatorVerdict } from './operatorVerdict';
import type { TradeDirective } from './tradeDirective';
import type { TradeLevels } from './tradeLevels';

const directive: TradeDirective = {
  action: 'INITIATE',
  lane: 'up',
  urgency: 'soon',
  recommendedSize: 0.55,
  headline: 'INITIATE UP',
  reason: 'edge aligned',
  evidence: ['edge aligned'],
  confidence: 'HIGH',
  defensive: false,
  edgePerShareUsd: 0.09,
  laneMid: 0.52,
  laneWinProb: 0.66,
  laneOutcomeLabel: 'UP',
};

const goVerdict: OperatorVerdict = {
  state: 'GO_LONG',
  color: 'green',
  bigVerb: 'ENTER UP',
  headline: '@ 0.52 — TP 0.60 / SL 0.48',
  reason: 'edge aligned',
  confidence: 'HIGH',
  blockers: [],
  primaryBlocker: null,
  isStandDown: false,
};

const levels: TradeLevels = {
  lane: 'up',
  entry: 0.52,
  takeProfit: 0.61,
  stopLoss: 0.48,
  takeProfitGain: 0.09,
  stopLossLoss: 0.04,
  rrRatio: 2.25,
  horizonSec: 120,
  summary: 'UP @ 0.52',
  collapsed: false,
};

describe('buildTraderDiscipline', () => {
  it('skips when the operator verdict is stand down', () => {
    const r = buildTraderDiscipline({
      directive,
      verdict: { ...goVerdict, state: 'STAND_DOWN', bigVerb: "DON'T TRADE", isStandDown: true, primaryBlocker: 'whipsaw', blockers: ['whipsaw'] },
      levels,
    });
    expect(r.mode).toBe('SKIP');
    expect(r.sizePct).toBe(0);
    expect(r.headline).toMatch(/Skip/i);
  });

  it('manages exits before suggesting a new entry', () => {
    const r = buildTraderDiscipline({
      directive: { ...directive, action: 'FLIP', flipHeldOutcomeLabel: 'DOWN' },
      verdict: { ...goVerdict, state: 'EXIT_NOW', bigVerb: 'FLIP UP', color: 'red' },
      levels,
    });
    expect(r.mode).toBe('MANAGE');
    expect(r.rules[0]).toMatch(/Close DOWN/i);
  });

  it('presses high-quality setups with strong edge and R:R', () => {
    const r = buildTraderDiscipline({ directive, verdict: goVerdict, levels });
    expect(r.mode).toBe('PRESS');
    expect(r.score).toBeGreaterThanOrEqual(78);
    expect(r.sizePct).toBeGreaterThan(0);
  });

  it('skips when the setup has poor reward versus risk plus caution flags', () => {
    const r = buildTraderDiscipline({
      directive: { ...directive, edgePerShareUsd: 0.02, confidence: 'MED' },
      verdict: { ...goVerdict, confidence: 'MED' },
      levels: { ...levels, takeProfit: 0.55, stopLoss: 0.47, takeProfitGain: 0.03, stopLossLoss: 0.05, rrRatio: 0.6 },
      noTradeScore: { score: 44, tier: 'YELLOW', summary: 'CAUTION — thin edge.', contributions: [] },
    });
    expect(r.mode).toBe('SKIP');
    expect(r.sizePct).toBe(0);
    expect(r.blockers.join(' ')).toMatch(/R:R/);
  });
});
