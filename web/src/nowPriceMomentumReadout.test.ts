import { describe, expect, it } from 'vitest';
import { buildNowPriceMomentumReadout } from './nowPriceMomentumReadout';
import type { PressureBuildupSnapshot } from './pressureBuildupScore';
import type { BuySideAdvisory } from './shouldBuyWhichSide';
import type { ContractLeadSignal } from './contractLeadSignal';

function pressureEarlyUp(): PressureBuildupSnapshot {
  return {
    earlyHorizonSec: 10,
    confirmHorizonSec: 30,
    horizonSec: 10,
    buy: {} as never,
    sell: {} as never,
    earlyScore: 4,
    confirmScore: 2,
    timing: 'EARLY',
    timingReadout: {} as never,
    leadNote: null,
    bias: 'BUY',
    verdict: 'EARLY_ENTRY',
    headline: 'EARLY BUY PRESSURE',
    emoji: '🟢',
    scoreLine: '4/5',
    tagline: '',
    gainSummary: null,
    entryJump: null,
    earlyEntryJump: null,
    spotJumpLine: null,
    contractLead: null,
    active: {} as never,
    confirmActive: {} as never,
    mtfSummary: null,
  };
}

function advisoryUp(): BuySideAdvisory {
  return {
    verdict: 'BUY_UP',
    confidence: 'MED',
    confidencePct: 64,
    recommendation: 'Buy UP on continuation',
    mid: 0.52,
    cautionFresh: false,
  } as BuySideAdvisory;
}

describe('buildNowPriceMomentumReadout', () => {
  it('surfaces early UP momentum with tape delta', () => {
    const r = buildNowPriceMomentumReadout({
      pressure: pressureEarlyUp(),
      pressureTiming: 'EARLY',
      advisory: advisoryUp(),
      contractLead: null,
      binaryBiasPUp: 0.58,
      machineReadout: null,
      probDeltaUp01: 0.012,
      probDeltaDown01: -0.004,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(r).not.toBeNull();
    expect(r!.phase).toBe('early');
    expect(r!.lane).toBe('up');
    expect(r!.headline).toContain('early 10s momentum');
    expect(r!.biasAligned).toBe(true);
    expect(r!.canCatch).toBe(true);
  });

  it('shows building tape when bias not aligned yet', () => {
    const r = buildNowPriceMomentumReadout({
      pressure: { ...pressureEarlyUp(), timing: 'BUILDING', earlyScore: 3, bias: 'SELL' },
      pressureTiming: 'BUILDING',
      advisory: { ...advisoryUp(), verdict: 'NEITHER', confidencePct: 40 } as BuySideAdvisory,
      contractLead: {
        phase: 'WATCH',
        sideLabel: 'Up',
        actionLine: 'UP +1.2¢ on 10s',
        reasonLine: 'score 4/5',
      } as ContractLeadSignal,
      binaryBiasPUp: 0.51,
      machineReadout: null,
      probDeltaUp01: 0.008,
      probDeltaDown01: null,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(r).not.toBeNull();
    expect(r!.phase).toBe('building');
    expect(r!.lane).toBe('up');
    expect(r!.biasAligned).toBe(false);
    expect(r!.headline).toContain('Up');
  });

  it('does not infer DOWN from UP-only spread noise', () => {
    const r = buildNowPriceMomentumReadout({
      pressure: { ...pressureEarlyUp(), timing: 'BUILDING', earlyScore: 4, bias: 'SELL' },
      pressureTiming: 'BUILDING',
      advisory: null,
      contractLead: null,
      binaryBiasPUp: 0.45,
      machineReadout: null,
      probDeltaUp01: -0.003,
      probDeltaDown01: 0.0001,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(r).toBeNull();
  });

  it('returns chasing headline when extended', () => {
    const r = buildNowPriceMomentumReadout({
      pressure: { ...pressureEarlyUp(), timing: 'CHASING', earlyScore: 2, confirmScore: 5 },
      pressureTiming: 'CHASING',
      advisory: advisoryUp(),
      contractLead: null,
      binaryBiasPUp: 0.6,
      machineReadout: null,
      probDeltaUp01: 0.02,
      probDeltaDown01: null,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(r).not.toBeNull();
    expect(r!.phase).toBe('chasing');
    expect(r!.canCatch).toBe(false);
    expect(r!.headline).toContain("don't chase");
  });
});
