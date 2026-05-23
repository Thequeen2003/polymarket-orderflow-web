import { describe, expect, it } from 'vitest';
import type { OperatorVerdict } from './operatorVerdict';
import type { TradeDirective } from './tradeDirective';
import { buildTakeSignalPlan, MIN_MS_REMAINING_TO_EXECUTE } from './takeSignalDesk';
import { applyTakeSignalStrategies, normalizeTakeSignalStrategyIds } from './takeSignalStrategy';
import { suggestTradeLevels } from './tradeLevels';

const goUp: OperatorVerdict = {
  state: 'GO_LONG',
  color: 'green',
  bigVerb: 'ENTER UP',
  headline: '@ 0.62',
  reason: 'edge',
  confidence: 'HIGH',
  blockers: [],
  primaryBlocker: null,
  isStandDown: false,
};

const underFiveMin = MIN_MS_REMAINING_TO_EXECUTE - 1_000;

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
  laneMid: 0.62,
  laneWinProb: 0.58,
};

describe('takeSignalStrategy', () => {
  it('normalizes and dedupes strategy ids', () => {
    expect(normalizeTakeSignalStrategyIds(['high-confidence', 'bogus', 'high-confidence'])).toEqual([
      'high-confidence',
    ]);
  });

  it('leaves plan unchanged when no strategies active', () => {
    const levels = suggestTradeLevels({ lane: 'up', entry: 0.62, edgeUsd: 0.08 });
    const base = buildTakeSignalPlan({
      verdict: goUp,
      directive: initiateUp,
      levels,
      crossEngineLaneConflict: false,
      endsInMs: underFiveMin,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    const out = applyTakeSignalStrategies(
      base,
      {
        verdict: goUp,
        directive: initiateUp,
        machine: null,
        noTradeScore: null,
        crossEngineLaneConflict: false,
        deskAction: null,
        tape: null,
      },
      [],
    );
    expect(out).toEqual(base);
  });

  it('blocks when high-confidence strategy and card is MED', () => {
    const levels = suggestTradeLevels({ lane: 'up', entry: 0.62, edgeUsd: 0.08 });
    const base = buildTakeSignalPlan({
      verdict: goUp,
      directive: { ...initiateUp, confidence: 'MED' },
      levels,
      crossEngineLaneConflict: false,
      endsInMs: underFiveMin,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(base.canTake).toBe(true);
    const out = applyTakeSignalStrategies(
      base,
      {
        verdict: goUp,
        directive: { ...initiateUp, confidence: 'MED' },
        machine: null,
        noTradeScore: null,
        crossEngineLaneConflict: false,
        deskAction: null,
        tape: null,
      },
      ['high-confidence'],
    );
    expect(out.canTake).toBe(false);
    expect(out.disabledReason).toMatch(/High confidence/i);
  });
});
