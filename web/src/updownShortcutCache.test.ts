import { describe, expect, it } from 'vitest';

import {
  fallbackUpdownSlug,
  inferredBucketStartSec,
  isUpdownShortcutWindowOpen,
  preloadedMarketForSlug,
  slugToOpenFromShortcut,
} from './updownShortcutCache';

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

  it('rejects expired shortcut windows', () => {
    expect(
      isUpdownShortcutWindowOpen({
        slug: 'btc-updown-5m-100',
        asset: 'btc',
        window: '5m',
        end: '2020-01-01T00:05:00.000Z',
      }),
    ).toBe(false);
  });

  it('uses trading window metadata for hints', () => {
    expect(
      inferredBucketStartSec(
        {
          slug: 'btc-updown-5m-100',
          trading_slug: 'btc-updown-5m-95',
          asset: 'btc',
          window: '5m',
          inferred_window_start_unix: 100,
          trading_inferred_window_start_unix: 95,
        },
        'btc-updown-5m-95',
      ),
    ).toBe(95);
  });

  it('only preloads market when slug matches', () => {
    const market = { slug: 'btc-updown-5m-100' };
    expect(preloadedMarketForSlug(market, 'btc-updown-5m-100')).toBe(market);
    expect(preloadedMarketForSlug(market, 'btc-updown-5m-95')).toBeUndefined();
  });
});
