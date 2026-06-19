import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildTakeSignalPlan,
  executeTakeSignal,
  marketUsesFiveMinuteExecuteGate,
  MIN_MS_REMAINING_TO_EXECUTE,
  parseDeskEnterLane,
  pickDeskActionForTake,
  roundTimerAllowsExecute,
  roundTimerExecuteBlockReason,
} from './takeSignalDesk';
import type { DeskSingleAction } from './deskSingleAction';
import type { OperatorVerdict } from './operatorVerdict';
import type { TradeDirective } from './tradeDirective';
import type { ExecutionSignal } from './executionSignal';
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

/** Under 5:00 on the bell — required for take / auto-trade execution. */
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

describe('buildTakeSignalPlan', () => {
  it('allows take when GO + INITIATE + levels', () => {
    const levels = suggestTradeLevels({ lane: 'up', entry: 0.62, edgeUsd: 0.08 });
    const p = buildTakeSignalPlan({
      verdict: goUp,
      directive: initiateUp,
      levels,
      crossEngineLaneConflict: false,
      endsInMs: underFiveMin,
      upLabel: 'BTC Up',
      downLabel: 'BTC Down',
    });
    expect(p.canTake).toBe(true);
    expect(p.lane).toBe('up');
    expect(p.entry01).toBeCloseTo(0.62, 3);
    expect(p.buttonLabel).toMatch(/Take signal/i);
    expect(p.buttonLabel).toMatch(/ENTER UP/i);
  });

  it('blocks on stand-down when directive is thin (LOW)', () => {
    const p = buildTakeSignalPlan({
      verdict: { ...goUp, isStandDown: true, state: 'STAND_DOWN', bigVerb: "DON'T TRADE" },
      directive: { ...initiateUp, confidence: 'LOW' },
      levels: null,
      crossEngineLaneConflict: false,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(p.canTake).toBe(false);
  });

  it('allows take on stand-down when directive is MED/HIGH initiate', () => {
    const levels = suggestTradeLevels({ lane: 'up', entry: 0.62, edgeUsd: 0.08 });
    const p = buildTakeSignalPlan({
      verdict: { ...goUp, isStandDown: true, state: 'STAND_DOWN', bigVerb: "DON'T TRADE" },
      directive: initiateUp,
      levels,
      crossEngineLaneConflict: false,
      endsInMs: underFiveMin,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(p.canTake).toBe(true);
  });

  it('blocks take when execution desk is not ENTER', () => {
    const levels = suggestTradeLevels({ lane: 'up', entry: 0.62, edgeUsd: 0.08 });
    const execution = {
      phase: 'ALERT',
      verdict: 'WAIT',
      proposedLane: 'up',
      headline: 'ALERT BTC Up — confirm continuation',
      summaryLine: 'Edge live — hold gates 7s before enter',
      confirmHeldMs: 2000,
      confirmRequiredMs: 7000,
    } as ExecutionSignal;
    const p = buildTakeSignalPlan({
      verdict: goUp,
      directive: initiateUp,
      levels,
      crossEngineLaneConflict: false,
      endsInMs: underFiveMin,
      upLabel: 'Up',
      downLabel: 'Down',
      requireExecutionEnter: true,
      execution,
    });
    expect(p.canTake).toBe(false);
    expect(p.disabledReason).toMatch(/ALERT/i);
  });

  it('allows take when execution desk ENTER matches card lane', () => {
    const levels = suggestTradeLevels({ lane: 'up', entry: 0.62, edgeUsd: 0.08 });
    const execution = {
      phase: 'ENTER',
      verdict: 'ENTER_UP',
      proposedLane: 'up',
      headline: 'ENTER BTC Up',
      summaryLine: 'Continuation confirmed',
      confirmHeldMs: 7000,
      confirmRequiredMs: 7000,
    } as ExecutionSignal;
    const p = buildTakeSignalPlan({
      verdict: goUp,
      directive: initiateUp,
      levels,
      crossEngineLaneConflict: false,
      endsInMs: underFiveMin,
      upLabel: 'Up',
      downLabel: 'Down',
      requireExecutionEnter: true,
      execution,
    });
    expect(p.canTake).toBe(true);
  });

  it('blocks take on execution lane mismatch', () => {
    const levels = suggestTradeLevels({ lane: 'up', entry: 0.62, edgeUsd: 0.08 });
    const execution = {
      phase: 'ENTER',
      verdict: 'ENTER_DOWN',
      proposedLane: 'down',
      headline: 'ENTER BTC Down',
      summaryLine: 'Continuation confirmed',
      confirmHeldMs: 7000,
      confirmRequiredMs: 7000,
    } as ExecutionSignal;
    const p = buildTakeSignalPlan({
      verdict: goUp,
      directive: initiateUp,
      levels,
      crossEngineLaneConflict: false,
      endsInMs: underFiveMin,
      upLabel: 'Up',
      downLabel: 'Down',
      requireExecutionEnter: true,
      execution,
    });
    expect(p.canTake).toBe(false);
    expect(p.disabledReason).toMatch(/lane mismatch|ENTER/i);
  });

  it('blocks cross-engine conflict only on thin LOW initiate', () => {
    const levels = suggestTradeLevels({ lane: 'up', entry: 0.62, edgeUsd: 0.08 });
    const blocked = buildTakeSignalPlan({
      verdict: goUp,
      directive: { ...initiateUp, confidence: 'LOW' },
      levels,
      crossEngineLaneConflict: true,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(blocked.canTake).toBe(false);
    expect(blocked.disabledReason).toMatch(/CONFLICT/i);

    const allowed = buildTakeSignalPlan({
      verdict: goUp,
      directive: { ...initiateUp, confidence: 'HIGH' },
      levels,
      crossEngineLaneConflict: true,
      endsInMs: underFiveMin,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(allowed.canTake).toBe(true);
  });

  it('blocks take when bell is still at or above 5:00 on 5m market', () => {
    const levels = suggestTradeLevels({ lane: 'up', entry: 0.62, edgeUsd: 0.08 });
    const p = buildTakeSignalPlan({
      verdict: goUp,
      directive: initiateUp,
      levels,
      crossEngineLaneConflict: false,
      endsInMs: MIN_MS_REMAINING_TO_EXECUTE,
      slug: 'btc-updown-5m-1730001000',
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(p.canTake).toBe(false);
    expect(p.disabledReason).toMatch(/under 5:00/i);
    expect(p.buttonLabel).toMatch(/wait for bell/i);
  });

  it('allows take above 5:00 remaining on 15m market', () => {
    const levels = suggestTradeLevels({ lane: 'up', entry: 0.62, edgeUsd: 0.08 });
    const p = buildTakeSignalPlan({
      verdict: goUp,
      directive: initiateUp,
      levels,
      crossEngineLaneConflict: false,
      endsInMs: 12 * 60_000,
      slug: 'btc-updown-15m-1730001000',
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(p.canTake).toBe(true);
    expect(marketUsesFiveMinuteExecuteGate('btc-updown-15m-1730001000')).toBe(false);
  });

  it('allows take when Do this now shows ENTER UP aligned with directive', () => {
    const levels = suggestTradeLevels({ lane: 'up', entry: 0.62, edgeUsd: 0.08 });
    const deskAction: DeskSingleAction = {
      primary: 'ENTER UP @ 62.0¢ · TP 74.0¢ · SL 55.0¢',
      detail: null,
      tone: 'green',
      wallBidWarning: null,
      physicsLine: null,
    };
    const p = buildTakeSignalPlan({
      verdict: { ...goUp, state: 'HOLD', bigVerb: 'HOLD UP' },
      directive: initiateUp,
      levels,
      crossEngineLaneConflict: false,
      deskAction,
      endsInMs: underFiveMin,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(p.canTake).toBe(true);
    expect(p.lane).toBe('up');
  });
});

describe('roundTimerAllowsExecute', () => {
  it('requires strictly under 5:00 remaining on 5m slugs', () => {
    const slug5 = 'btc-updown-5m-1730001000';
    expect(roundTimerAllowsExecute(MIN_MS_REMAINING_TO_EXECUTE - 1, slug5)).toBe(true);
    expect(roundTimerAllowsExecute(MIN_MS_REMAINING_TO_EXECUTE, slug5)).toBe(false);
    expect(roundTimerAllowsExecute(null, slug5)).toBe(true);
    // Bell >5:00 cannot be a 5m round end window — allow (same rule as 15m at 9:40).
    expect(roundTimerAllowsExecute(MIN_MS_REMAINING_TO_EXECUTE + 60_000, slug5)).toBe(true);
  });

  it('skips 5:00 gate for 15m slugs', () => {
    const slug15 = 'btc-updown-15m-1730001000';
    expect(roundTimerAllowsExecute(14 * 60_000, slug15)).toBe(true);
    expect(roundTimerAllowsExecute(MIN_MS_REMAINING_TO_EXECUTE + 60_000, slug15)).toBe(true);
  });

  it('skips 5:00 gate when bell shows more than 5:00 left (e.g. 15m at 9:40)', () => {
    const nineForty = (9 * 60 + 40) * 1000;
    expect(marketUsesFiveMinuteExecuteGate('btc-updown-5m-wrong', nineForty)).toBe(false);
    expect(roundTimerExecuteBlockReason(nineForty, null)).toBeNull();
    expect(roundTimerAllowsExecute(nineForty, null)).toBe(true);
  });
});

describe('pickDeskActionForTake', () => {
  it('prefers live ENTER over spot WAIT', () => {
    const spot: DeskSingleAction = {
      primary: 'WAIT — confirm break',
      detail: null,
      tone: 'amber',
      wallBidWarning: null,
      physicsLine: null,
    };
    const live: DeskSingleAction = {
      primary: 'ENTER UP @ 62.0¢ · TP 74.0¢ · SL 55.0¢',
      detail: null,
      tone: 'green',
      wallBidWarning: null,
      physicsLine: null,
    };
    expect(pickDeskActionForTake(spot, live)).toEqual(live);
  });
});

describe('buildTakeSignalPlan lane', () => {
  it('prefers directive DOWN over GO_LONG verdict when desk shows ENTER DOWN', () => {
    const levels = suggestTradeLevels({ lane: 'down', entry: 0.4, edgeUsd: 0.06 });
    const deskAction: DeskSingleAction = {
      primary: 'ENTER DOWN @ 40.0¢ · TP 52.0¢ · SL 32.0¢',
      detail: null,
      tone: 'green',
      wallBidWarning: null,
      physicsLine: null,
    };
    const p = buildTakeSignalPlan({
      verdict: goUp,
      directive: { ...initiateUp, lane: 'down', headline: 'INITIATE DOWN' },
      levels,
      crossEngineLaneConflict: false,
      deskAction,
      endsInMs: underFiveMin,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(p.canTake).toBe(true);
    expect(p.lane).toBe('down');
  });
});

describe('parseDeskEnterLane', () => {
  it('parses ENTER UP/DOWN primary lines', () => {
    expect(parseDeskEnterLane('ENTER UP @ 62.0¢ · TP 74.0¢')).toBe('up');
    expect(parseDeskEnterLane('ENTER DOWN @ 40.0¢')).toBe('down');
    expect(parseDeskEnterLane('WAIT — in band')).toBeNull();
  });
});

describe('executeTakeSignal', () => {
  beforeAll(() => {
    if (typeof globalThis.window === 'undefined') {
      vi.stubGlobal('window', {
        dispatchEvent: vi.fn(),
        setTimeout: (fn: () => void, _ms?: number) => {
          fn();
          return 0;
        },
        clearTimeout: vi.fn(),
      });
    }
  });

  it('returns buySkippedReason when submitBuy blocked by bell', () => {
    const levels = suggestTradeLevels({ lane: 'up', entry: 0.62, edgeUsd: 0.08 });
    const plan = buildTakeSignalPlan({
      verdict: goUp,
      directive: initiateUp,
      levels,
      crossEngineLaneConflict: false,
      endsInMs: underFiveMin,
      slug: 'btc-updown-5m-1730001000',
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(plan.canTake).toBe(true);
    const r = executeTakeSignal(plan, 'btc-updown-5m-1730001000', {
      submitBuy: true,
      sizeShares: 5,
      endsInMs: MIN_MS_REMAINING_TO_EXECUTE,
    });
    expect(r.prefilled).toBe(true);
    expect(r.buySubmitted).toBe(false);
    expect(r.buySkippedReason).toMatch(/bell/i);
  });
});
