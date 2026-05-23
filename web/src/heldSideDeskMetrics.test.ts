import { describe, expect, it } from 'vitest';
import { buildHeldSideDeskMetrics } from './heldSideDeskMetrics';
import { computeTapeVelocity } from './tapeVelocity';
import type { TradeDirective } from './tradeDirective';

const tapeReliable = computeTapeVelocity(
  [
    { ts: 1_700_000_000_000, side: 'buy', size: 10 },
    { ts: 1_700_000_000_100, side: 'buy', size: 12 },
    { ts: 1_700_000_000_200, side: 'sell', size: 4 },
    { ts: 1_700_000_000_300, side: 'buy', size: 8 },
  ],
  { now: 1_700_000_000_500 },
);

describe('buildHeldSideDeskMetrics', () => {
  it('formats held Up mid, bell, cross, agreement, tape, card', () => {
    const d: TradeDirective = {
      action: 'HOLD',
      lane: 'up',
      urgency: 'patient',
      recommendedSize: 0,
      headline: 'HOLD UP',
      reason: 'r',
      evidence: [],
      confidence: 'HIGH',
      defensive: false,
      edgePerShareUsd: 0.1,
      laneMid: 0.55,
      laneWinProb: 0.6,
    };
    const m = buildHeldSideDeskMetrics({
      myLane: 'up',
      heldAtMid01: 0.95,
      impliedMidUp01: 0.531,
      impliedMidDown01: 0.469,
      crossProb: 0.44,
      agreementScore: 78,
      endsInMs: 125_000,
      takenAtMs: 1_700_000_000_000,
      nowMs: 1_700_000_000_000 + 3 * 60_000,
      tape: tapeReliable,
      directive: d,
      upLabel: 'BTC Up',
      downLabel: 'BTC Down',
    });
    expect(m.holdBanner).toBe('BTC Up @ 95.0¢');
    expect(m.holdAnchorMid).toBe('95.0¢');
    expect(m.vsHoldTag).toBe('-41.9¢ vs tag');
    expect(m.impliedMid).toBe('53.1¢');
    expect(m.bell).toBe('2:05');
    expect(m.cross).toBe('44%');
    expect(m.agreement).toBe('78%');
    expect(m.inTrade).toMatch(/^3m/);
    expect(m.tape).toMatch(/buy/i);
    expect(m.card).toBe('HOLD · BTC Up');
  });

  it('uses Down mid when myLane is down', () => {
    const m = buildHeldSideDeskMetrics({
      myLane: 'down',
      heldAtMid01: null,
      impliedMidUp01: 0.4,
      impliedMidDown01: 0.612,
      crossProb: null,
      agreementScore: null,
      endsInMs: null,
      takenAtMs: null,
      nowMs: 0,
      tape: tapeReliable,
      directive: null,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(m.holdBanner).toBe('Down');
    expect(m.holdAnchorMid).toBe('—');
    expect(m.vsHoldTag).toBe('—');
    expect(m.impliedMid).toBe('61.2¢');
    expect(m.cross).toBe('—');
    expect(m.card).toBe('Loading…');
  });
});
