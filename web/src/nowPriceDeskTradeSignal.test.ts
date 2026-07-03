import { describe, expect, it } from 'vitest';
import { buildNowPriceDeskTradeSignal } from './nowPriceDeskTradeSignal';
import type { ExecutionSignal } from './executionSignal';
import type { EntryMoment } from './entryMoment';

function execEnterUp(): ExecutionSignal {
  return {
    phase: 'ENTER',
    verdict: 'ENTER_UP',
    proposedLane: 'up',
    emoji: '🟢',
    headline: 'All gates passed',
    summaryLine: 'Enter UP on continuation',
    confirmHeldMs: 7000,
    confirmRequiredMs: 7000,
    baseAlert: true,
    allGatesPass: true,
    gates: [{ id: 'baseEdge', label: 'Edge', pass: true, detail: 'ok' }],
    blockReasons: [],
    dynamicTp: { minCents: 5, maxCents: 8, regimeLabel: 'trend', regime: 'trend_up', tp1Cents: 5, tp2Range: null, timeStopSec: 120 },
    regimePlan: { regime: 'trend_up', timeStopMs: 120_000, tp1Cents: 5, tp2LoCents: 8, tp2HiCents: 12 },
    bias: { direction: 'up', strength: 'strong', label: 'UP' },
    entry: { eligible: true, lane: 'up', hardBlock: false, reasons: [] },
  } as ExecutionSignal;
}

describe('buildNowPriceDeskTradeSignal', () => {
  it('prioritizes execution ENTER', () => {
    const r = buildNowPriceDeskTradeSignal({
      execution: execEnterUp(),
      entryMoment: null,
      advisory: null,
      directionEngine: null,
      tpOutlook: { tpHitProb01: 0.62, tpCents: 65 } as never,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(r.phase).toBe('ENTER');
    expect(r.lane).toBe('up');
    expect(r.canTrade).toBe(true);
    expect(r.tpHitProbPct).toBe(62);
  });

  it('uses entry moment ENTER_NOW when execution not ready', () => {
    const entryMoment: EntryMoment = {
      phase: 'ENTER_NOW',
      lane: 'down',
      headline: 'ENTER DOWN NOW',
      exactAction: 'Click take signal',
      readinessPct: 100,
      confirmSecRemaining: 0,
      checks: [],
      urgency: 'now',
      canExecute: true,
    };
    const r = buildNowPriceDeskTradeSignal({
      execution: null,
      entryMoment,
      advisory: null,
      directionEngine: null,
      tpOutlook: null,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(r.phase).toBe('ENTER');
    expect(r.lane).toBe('down');
    expect(r.source).toBe('entry_moment');
  });

  it('surfaces ALERT with confirm countdown', () => {
    const execution = {
      ...execEnterUp(),
      phase: 'ALERT' as const,
      verdict: 'WAIT' as const,
      confirmHeldMs: 3000,
      confirmRequiredMs: 7000,
      gates: [
        { id: 'confirmHold', label: '7s confirmation', pass: false, detail: '3s / 7s' },
      ],
    };
    const r = buildNowPriceDeskTradeSignal({
      execution: execution as ExecutionSignal,
      entryMoment: null,
      advisory: null,
      directionEngine: null,
      tpOutlook: null,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(r.phase).toBe('ALERT');
    expect(r.confirmSecRemaining).toBeGreaterThan(0);
    expect(r.blockers).toContain('7s confirmation');
  });

  it('surfaces LEAN DOWN on strong advisory when pressure is chasing', () => {
    const entryMoment: EntryMoment = {
      phase: 'WAIT_PULLBACK',
      lane: 'down',
      headline: 'WAIT FOR PULLBACK',
      exactAction: 'Move already ran — do not chase the ask. Re-enter when pressure is EARLY (<4pp on 10s).',
      readinessPct: 25,
      confirmSecRemaining: null,
      checks: [{ id: 'pressure', label: 'Pressure timing', pass: false, detail: 'chasing' }],
      urgency: 'wait',
      canExecute: false,
    };
    const r = buildNowPriceDeskTradeSignal({
      execution: null,
      entryMoment,
      advisory: {
        verdict: 'BUY_DOWN',
        confidence: 'HIGH',
        confidencePct: 75,
        cautionFresh: false,
        recommendation: 'BUY DOWN — strong consensus.',
      } as never,
      directionEngine: {
        verdict: 'ENTER_DOWN',
        headline: 'ENTER Down',
        confidencePct: 68,
        emoji: '🔴',
        hardRule: false,
      } as never,
      tpOutlook: { tpHitProb01: 0.38, tpCents: 82 } as never,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(r.phase).toBe('LEAN');
    expect(r.lane).toBe('down');
    expect(r.readinessPct).toBeGreaterThanOrEqual(60);
    expect(r.exactAction).toMatch(/join on bid/i);
    expect(r.exactAction).not.toContain('Re-enter when pressure is EARLY');
  });

  it('surfaces ENTER inside momentum from contract lead', () => {
    const r = buildNowPriceDeskTradeSignal({
      execution: null,
      entryMoment: {
        phase: 'ENTER_NOW',
        lane: 'down',
        headline: 'ENTER DOWN — inside momentum',
        exactAction: 'Buy inside the move',
        readinessPct: 88,
        confirmSecRemaining: 0,
        checks: [],
        urgency: 'now',
        canExecute: true,
      },
      advisory: { verdict: 'BUY_DOWN', confidence: 'HIGH', confidencePct: 75, cautionFresh: false } as never,
      directionEngine: null,
      contractLead: {
        phase: 'ENTER',
        sideLabel: 'DOWN',
        title: 'Enter DOWN',
        actionLine: '10s +1.5¢ underway',
        reasonLine: 'Momentum building',
        nowCents: '62¢',
        entry10sCents: '60¢',
        earlyGainCents: 1.5,
        confirmGainCents: 0.4,
        earlyHorizonSec: 10,
        confirmHorizonSec: 30,
      },
      pressureTiming: 'BUILDING',
      tpOutlook: null,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(r.phase).toBe('ENTER');
    expect(r.canTrade).toBe(true);
    expect(r.headline).toMatch(/inside momentum/i);
  });
});
