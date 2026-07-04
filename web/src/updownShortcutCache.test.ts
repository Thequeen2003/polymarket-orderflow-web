import { describe, expect, it } from 'vitest';

import { fallbackUpdownSlug, liveSlugFromUpdownShortcut, slugToOpenFromShortcut } from './updownShortcutCache';

describe('updownShortcutCache', () => {
  it('builds titled hourly fallback slug for 1h', () => {
    const slug = fallbackUpdownSlug('btc', '1h');
    expect(slug).toMatch(/^bitcoin-up-or-down-[a-z]+-\d+-\d+-\d+(am|pm)-et$/);
  });

  it('builds titled daily fallback slug for 1d', () => {
    const slug = fallbackUpdownSlug('eth', '1d');
    expect(slug).toMatch(/^ethereum-up-or-down-on-[a-z]+-\d+-\d+$/);
  });

  it('builds canonical fallback slug for 5m', () => {
    const slug = fallbackUpdownSlug('btc', '5m');
    expect(slug).toMatch(/^btc-updown-5m-\d+$/);
  });

  it('builds ET-aligned canonical fallback slug for 4h', () => {
    const slug = fallbackUpdownSlug('btc', '4h');
    expect(slug).toMatch(/^btc-updown-4h-\d+$/);
    const ts = Number(slug.split('-').pop());
    const nowSec = Math.floor(Date.now() / 1000);
    expect(ts).toBeLessThanOrEqual(nowSec);
    expect(nowSec - ts).toBeLessThan(4 * 3600);
  });

  it('prefers trading_slug when opening', () => {
    expect(
      slugToOpenFromShortcut(
        { slug: 'btc-updown-5m-100', trading_slug: 'btc-updown-5m-95', asset: 'btc', window: '5m' },
        '5m',
      ),
    ).toBe('btc-updown-5m-95');
  });

  it('liveSlugFromUpdownShortcut matches trading slug for desk poll', () => {
    expect(
      liveSlugFromUpdownShortcut(
        { slug: 'btc-updown-5m-200', trading_slug: 'btc-updown-5m-195', asset: 'btc', window: '5m' },
        '5m',
      ),
    ).toBe('btc-updown-5m-195');
  });
});
