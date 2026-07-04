import { describe, expect, it } from 'vitest';
import {
  pickUpdownAutoRollTarget,
  shouldAutoRollUpdownMarket,
  shouldClearUpdownAutoRollKey,
  updownAutoRollPollMs,
} from './updownAutoRoll';

describe('updownAutoRoll', () => {
  it('rolls when the window ended or Gamma closed the market', () => {
    expect(shouldAutoRollUpdownMarket({ endsInMs: -1_000, marketClosed: false })).toBe(true);
    expect(shouldAutoRollUpdownMarket({ endsInMs: 4_500, marketClosed: false })).toBe(true);
    expect(shouldAutoRollUpdownMarket({ endsInMs: null, marketClosed: true })).toBe(true);
    expect(shouldAutoRollUpdownMarket({ endsInMs: 60_000, marketClosed: false })).toBe(false);
  });

  it('clears roll lock when the new window has time left', () => {
    expect(shouldClearUpdownAutoRollKey(10_000)).toBe(true);
    expect(shouldClearUpdownAutoRollKey(5_000)).toBe(false);
    expect(shouldClearUpdownAutoRollKey(null)).toBe(false);
  });

  it('prefers step-next slug, then live API slug', () => {
    expect(
      pickUpdownAutoRollTarget({
        selectedSlug: 'btc-updown-5m-1000',
        stepNextSlug: 'btc-updown-5m-1300',
        liveSlugFromApi: 'btc-updown-5m-1300',
      }),
    ).toEqual({ slug: 'btc-updown-5m-1300', forceReload: false });

    expect(
      pickUpdownAutoRollTarget({
        selectedSlug: 'btc-updown-5m-1000',
        stepNextSlug: 'btc-updown-5m-1000',
        liveSlugFromApi: 'btc-updown-5m-1300',
      }),
    ).toEqual({ slug: 'btc-updown-5m-1300', forceReload: false });
  });

  it('force-reloads when still on the same slug but window ended', () => {
    expect(
      pickUpdownAutoRollTarget({
        selectedSlug: 'btc-updown-5m-1000',
        stepNextSlug: 'btc-updown-5m-1000',
        liveSlugFromApi: null,
      }),
    ).toEqual({ slug: 'btc-updown-5m-1000', forceReload: true });
  });

  it('polls faster as the window ends', () => {
    expect(updownAutoRollPollMs(-500)).toBe(150);
    expect(updownAutoRollPollMs(2_000)).toBe(300);
    expect(updownAutoRollPollMs(10_000)).toBe(700);
    expect(updownAutoRollPollMs(45_000)).toBe(1_500);
    expect(updownAutoRollPollMs(300_000)).toBe(4_000);
  });
});
