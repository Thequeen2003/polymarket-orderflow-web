import { describe, expect, it } from 'vitest';
import { deskAutoExitFireKey, shouldDispatchDeskAutoExit } from './deskAutoExit';
import type { PositionDeskSignal } from './positionDeskSignal';

function sellSignal(overrides: Partial<PositionDeskSignal> = {}): PositionDeskSignal {
  return {
    action: 'sell_now',
    severity: 'danger',
    badge: 'Sell now',
    headline: 'Desk TP below entry',
    detail: 'Exit',
    reason: 'desk_tp_below_entry',
    exitPressure: 85,
    midTrailCents: [62, 67, 68],
    entryCents: 65,
    bidCents: 63,
    deskTpNowCents: 64,
    deskTpLeadDropCents: 2,
    tpHitProbPct: 28,
    momentumPhase: 'fading',
    ...overrides,
  };
}

describe('shouldDispatchDeskAutoExit', () => {
  it('blocks when disabled or not holding', () => {
    expect(
      shouldDispatchDeskAutoExit({
        enabled: false,
        liveMode: true,
        heldLane: 'up',
        signal: sellSignal(),
        minExitPressure: 65,
      }).dispatch,
    ).toBe(false);
    expect(
      shouldDispatchDeskAutoExit({
        enabled: true,
        liveMode: true,
        heldLane: null,
        signal: sellSignal(),
        minExitPressure: 65,
      }).dispatch,
    ).toBe(false);
  });

  it('requires live mode and sell/tp action with enough pressure', () => {
    expect(
      shouldDispatchDeskAutoExit({
        enabled: true,
        liveMode: false,
        heldLane: 'up',
        signal: sellSignal(),
        minExitPressure: 65,
      }).blockReason,
    ).toMatch(/Paper mode/);

    expect(
      shouldDispatchDeskAutoExit({
        enabled: true,
        liveMode: true,
        heldLane: 'up',
        signal: sellSignal({ action: 'hold', exitPressure: 90 }),
        minExitPressure: 65,
      }).dispatch,
    ).toBe(false);

    expect(
      shouldDispatchDeskAutoExit({
        enabled: true,
        liveMode: true,
        heldLane: 'up',
        signal: sellSignal({ exitPressure: 40 }),
        minExitPressure: 65,
      }).dispatch,
    ).toBe(false);

    expect(
      shouldDispatchDeskAutoExit({
        enabled: true,
        liveMode: true,
        heldLane: 'down',
        signal: sellSignal({ action: 'take_profit', reason: 'tp_hit' }),
        minExitPressure: 65,
      }).dispatch,
    ).toBe(true);
  });
});

describe('deskAutoExitFireKey', () => {
  it('includes slug, lane, action, reason, and rounded pressure', () => {
    const key = deskAutoExitFireKey('btc-updown-5m', 'up', sellSignal({ exitPressure: 84.6 }));
    expect(key).toBe('btc-updown-5m|up|sell_now|desk_tp_below_entry|85');
  });
});
