import { describe, expect, it } from 'vitest';
import { EXEC_CONFIRM_HOLD_MS } from './executionSignal';
import type { ExecutionSignal } from './executionSignal';
import {
  computeEntryMoment,
  entryMomentAllowsDeskScalp,
  entryMomentDeskScalpBlockReason,
} from './entryMoment';
import type { BuySideAdvisory } from './shouldBuyWhichSide';

const buyUp: BuySideAdvisory = {
  verdict: 'BUY_UP',
  confidence: 'HIGH',
  recommendation: 'BUY UP — strong consensus.',
  reasons: ['test'],
  risks: [],
  suggestedSize: 0.8,
  edgePerShareUsd: 0.05,
  winProb: 0.78,
  mid: 0.62,
  scores: { up: 8, down: 2 },
  confidencePct: 82,
  momentumScore: 71,
  cautionFresh: false,
};

function execSignal(overrides: Partial<ExecutionSignal>): ExecutionSignal {
  return {
    proposedLane: 'up',
    baseAlert: true,
    allGatesPass: true,
    gates: [
      { id: 'baseEdge', label: 'Base edge', pass: true, detail: 'ok' },
      { id: 'momentum10s', label: '10s momentum', pass: true, detail: 'ok' },
      { id: 'noSpike', label: 'No spike chase', pass: true, detail: 'ok' },
      { id: 'ptbAlignment', label: 'PTB alignment', pass: true, detail: 'ok' },
      { id: 'noChop', label: 'No chop', pass: true, detail: 'ok' },
      { id: 'probStable', label: 'Prob stable', pass: true, detail: 'ok' },
      {
        id: 'confirmHold',
        label: 'Confirmation hold',
        pass: false,
        detail: 'building',
      },
    ],
    blockReasons: [],
    dynamicTp: {
      minCents: 4,
      maxCents: 8,
      regimeLabel: 'trend',
      regime: 'trend',
      tp1Cents: 5,
      tp2Range: '6–8¢',
      timeStopSec: 120,
    },
    regimePlan: {
      regime: 'trend',
      regimeLabel: 'trend',
      tp1Cents: 5,
      tp2MinCents: 6,
      tp2MaxCents: 8,
      timeStopSec: 120,
      pressureTiming: 'EARLY',
    },
    phase: 'ALERT',
    verdict: 'WAIT',
    emoji: '🟡',
    headline: 'ALERT UP — confirm continuation',
    summaryLine: 'Edge live',
    confirmHeldMs: 2000,
    confirmRequiredMs: EXEC_CONFIRM_HOLD_MS,
    bias: { direction: 'up', label: 'BUY UP', strength: 'strong', summary: '' },
    entry: { up: { pass: true, detail: '' }, down: { pass: false, detail: '' }, footer: '' },
    ...overrides,
  };
}

describe('computeEntryMoment', () => {
  it('ENTER_NOW when take plan is armed', () => {
    const m = computeEntryMoment({
      advisory: buyUp,
      execution: execSignal({ phase: 'ALERT' }),
      takePlan: {
        canTake: true,
        disabledReason: null,
        lane: 'up',
        entry01: 0.62,
        takeProfit01: 0.74,
        stopLoss01: 0.55,
        buttonLabel: 'Take signal · ENTER UP @ 62.0¢',
      },
    });
    expect(m.phase).toBe('ENTER_NOW');
    expect(m.canExecute).toBe(true);
    expect(m.exactAction).toContain('Enter now');
  });

  it('CONFIRMING with countdown when execution ALERT and gates pass', () => {
    const m = computeEntryMoment({
      advisory: buyUp,
      execution: execSignal({
        phase: 'ALERT',
        allGatesPass: true,
        confirmHeldMs: 4000,
      }),
    });
    expect(m.phase).toBe('CONFIRMING');
    expect(m.confirmSecRemaining).toBe(3);
    expect(m.canExecute).toBe(false);
    expect(m.exactAction).toContain('3s');
  });

  it('ENTER_NOW from execution ENTER phase', () => {
    const m = computeEntryMoment({
      advisory: buyUp,
      execution: execSignal({
        phase: 'ENTER',
        verdict: 'ENTER_UP',
        confirmHeldMs: EXEC_CONFIRM_HOLD_MS,
      }),
    });
    expect(m.phase).toBe('ENTER_NOW');
    expect(m.canExecute).toBe(true);
  });

  it('WAIT_PULLBACK when pressure is CHASING and desk edge is weak', () => {
    const m = computeEntryMoment({
      advisory: { ...buyUp, confidence: 'LOW', confidencePct: 42, cautionFresh: true },
      execution: execSignal({ pressureTiming: 'CHASING' } as Partial<ExecutionSignal> & { pressureTiming: 'CHASING' }),
      pressureTiming: 'CHASING',
    });
    expect(m.phase).toBe('WAIT_PULLBACK');
    expect(m.headline).toContain('PULLBACK');
  });

  it('LEAN alert when CHASING but desk edge is HIGH', () => {
    const m = computeEntryMoment({
      advisory: buyUp,
      pressureTiming: 'CHASING',
    });
    expect(m.phase).toBe('ALERT');
    expect(m.headline).toMatch(/LEAN/);
    expect(m.readinessPct).toBeGreaterThan(40);
    expect(m.exactAction).toMatch(/join on bid/i);
  });

  it('WAIT_SETUP when advisory is NEITHER', () => {
    const m = computeEntryMoment({
      advisory: { ...buyUp, verdict: 'NEITHER', recommendation: 'Stay flat.' },
      execution: null,
    });
    expect(m.phase).toBe('WAIT_SETUP');
    expect(m.canExecute).toBe(false);
  });

  it('ENTER_NOW on contract lead inside BUILDING momentum', () => {
    const m = computeEntryMoment({
      advisory: buyUp,
      execution: null,
      pressureTiming: 'BUILDING',
      contractLead: {
        phase: 'ENTER',
        sideLabel: 'UP',
        title: 'Enter UP',
        actionLine: '10s +1.2¢ underway',
        reasonLine: 'Momentum building',
        nowCents: '62¢',
        entry10sCents: '61¢',
        earlyGainCents: 1.2,
        confirmGainCents: 0.5,
        earlyHorizonSec: 10,
        confirmHorizonSec: 30,
      },
    });
    expect(m.phase).toBe('ENTER_NOW');
    expect(m.canExecute).toBe(true);
    expect(m.exactAction).toMatch(/inside the move/i);
  });
});

describe('entryMomentAllowsDeskScalp', () => {
  it('allows ENTER_NOW and late CONFIRMING', () => {
    expect(
      entryMomentAllowsDeskScalp({
        phase: 'ENTER_NOW',
        lane: 'up',
        headline: '',
        exactAction: '',
        readinessPct: 100,
        confirmSecRemaining: null,
        checks: [],
        urgency: 'now',
        canExecute: true,
      }),
    ).toBe(true);
    expect(
      entryMomentAllowsDeskScalp({
        phase: 'CONFIRMING',
        lane: 'up',
        headline: '',
        exactAction: '',
        readinessPct: 90,
        confirmSecRemaining: 2,
        checks: [],
        urgency: 'soon',
        canExecute: false,
      }),
    ).toBe(true);
    expect(
      entryMomentAllowsDeskScalp({
        phase: 'CONFIRMING',
        lane: 'up',
        headline: '',
        exactAction: '',
        readinessPct: 70,
        confirmSecRemaining: 6,
        checks: [],
        urgency: 'wait',
        canExecute: false,
      }),
    ).toBe(false);
  });

  it('allows momentum window when contract lead is ENTER', () => {
    expect(
      entryMomentAllowsDeskScalp(
        {
          phase: 'ALERT',
          lane: 'down',
          headline: 'ALERT DOWN',
          exactAction: 'inside momentum',
          readinessPct: 72,
          confirmSecRemaining: null,
          checks: [],
          urgency: 'soon',
          canExecute: false,
        },
        { contractLead: { phase: 'ENTER' } as never, pressureTiming: 'BUILDING' },
      ),
    ).toBe(true);
  });

  it('returns block reason when scalp not allowed', () => {
    const reason = entryMomentDeskScalpBlockReason({
      phase: 'WAIT_PULLBACK',
      lane: 'up',
      headline: 'WAIT',
      exactAction: 'Wait for dip.',
      readinessPct: 20,
      confirmSecRemaining: null,
      checks: [],
      urgency: 'wait',
      canExecute: false,
    });
    expect(reason).toBe('Wait for dip.');
  });
});
