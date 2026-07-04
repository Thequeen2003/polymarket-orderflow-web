import { describe, expect, it } from 'vitest';
import { buildNowPriceDeskTradeSignal } from './nowPriceDeskTradeSignal';
import type { NowPriceMomentumReadout } from './nowPriceMomentumReadout';

function momentumBuildingUp(): NowPriceMomentumReadout {
  return {
    phase: 'building',
    lane: 'up',
    laneLabel: 'Up',
    headline: '↑ Up building · tape + bias agree (4/5)',
    tapeLine: 'contract +1.2¢/30s · 10s 4/5 vs 2/5 confirm',
    actionHint: 'Catch Up on next 10s tick — bias + tape aligned.',
    earlyScore: 4,
    confirmScore: 2,
    timing: 'BUILDING',
    contractDeltaCents: 1.2,
    confirmations: [
      { label: '10s pressure', ok: true },
      { label: 'Contract tape', ok: true },
      { label: 'Settlement bias', ok: true },
      { label: 'Desk pick', ok: true },
      { label: 'Machine', ok: false },
    ],
    biasAligned: true,
    canCatch: true,
    emoji: '⚡',
  };
}

describe('buildNowPriceDeskTradeSignal momentum', () => {
  it('prefers momentum readout over generic LEAN when building', () => {
    const r = buildNowPriceDeskTradeSignal({
      execution: null,
      entryMoment: null,
      advisory: {
        verdict: 'BUY_UP',
        confidence: 'MED',
        confidencePct: 58,
        recommendation: 'Lean UP',
        mid: 0.55,
        cautionFresh: false,
      } as never,
      directionEngine: {
        verdict: 'ENTER_UP',
        headline: 'Direction UP',
        confidencePct: 60,
        emoji: '⚡',
        hardRule: false,
      } as never,
      tpOutlook: null,
      momentum: momentumBuildingUp(),
      pressureTiming: 'BUILDING',
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(r.source).toBe('momentum');
    expect(r.phase).toBe('ALERT');
    expect(r.headline).toContain('building');
  });
});
