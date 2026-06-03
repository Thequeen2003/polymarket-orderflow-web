import { describe, expect, it } from 'vitest';

import { fallbackUpdownSlug, slugToOpenFromShortcut } from './updownShortcutCache';

describe('updownShortcutCache', () => {
  it('builds canonical fallback slug', () => {
    const slug = fallbackUpdownSlug('btc', '1h');
    expect(slug).toMatch(/^btc-updown-1h-\d+$/);
  });

  it('prefers trading_slug when opening', () => {
    expect(
      slugToOpenFromShortcut(
        { slug: 'btc-updown-5m-100', trading_slug: 'btc-updown-5m-95', asset: 'btc', window: '5m' },
        '5m',
      ),
    ).toBe('btc-updown-5m-95');
  });
});
