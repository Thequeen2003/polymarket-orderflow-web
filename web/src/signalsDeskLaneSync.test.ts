import { describe, expect, it } from 'vitest';
import { shouldSyncTradePanelToMasterLane } from './signalsDeskHold';

describe('shouldSyncTradePanelToMasterLane', () => {
  it('syncs when the card lane first becomes ready', () => {
    expect(
      shouldSyncTradePanelToMasterLane({
        masterLane: 'up',
        previousMasterLane: null,
        manualPositionLane: null,
        masterReady: true,
      }),
    ).toBe(true);
  });

  it('does not re-sync when the card lane is unchanged (operator picked DOWN on panel)', () => {
    expect(
      shouldSyncTradePanelToMasterLane({
        masterLane: 'up',
        previousMasterLane: 'up',
        manualPositionLane: null,
        masterReady: true,
      }),
    ).toBe(false);
  });

  it('syncs when the card flips lane', () => {
    expect(
      shouldSyncTradePanelToMasterLane({
        masterLane: 'down',
        previousMasterLane: 'up',
        manualPositionLane: null,
        masterReady: true,
      }),
    ).toBe(true);
  });

  it('does not override I hold on the opposite side', () => {
    expect(
      shouldSyncTradePanelToMasterLane({
        masterLane: 'up',
        previousMasterLane: null,
        manualPositionLane: 'down',
        masterReady: true,
      }),
    ).toBe(false);
  });

  it('does not sync while the trade card is whipsawing', () => {
    expect(
      shouldSyncTradePanelToMasterLane({
        masterLane: 'down',
        previousMasterLane: 'up',
        manualPositionLane: null,
        masterReady: true,
        whipsaw: true,
      }),
    ).toBe(false);
  });
});
