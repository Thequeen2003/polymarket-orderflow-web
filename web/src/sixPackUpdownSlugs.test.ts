import { describe, expect, it } from 'vitest';
import {
  inferUpdownHintFromMarketJson,
  nextUpdownSlug,
  parseUpdownSlug,
  parseUpdownSlugWithHints,
  tradingSlugFromLiveShortcut,
} from './sixPackUpdownSlugs';

describe('sixPackUpdownSlugs', () => {
  it('parses updown slugs', () => {
    const p = parseUpdownSlug('btc-updown-5m-1730001000');
    expect(p?.asset).toBe('btc');
    expect(p?.interval).toBe('5m');
    expect(p?.stepSec).toBe(300);
    expect(p?.ts).toBe(1730001000);
  });

  it('shifts bucket with nextUpdownSlug', () => {
    const s = 'sol-updown-5m-900';
    expect(nextUpdownSlug(s, -1)).toBe('sol-updown-5m-600');
    expect(nextUpdownSlug(s, 1)).toBe('sol-updown-5m-1200');
  });

  it('5m trading slug uses prior bucket vs live shortcut', () => {
    const live = 'eth-updown-5m-1200';
    expect(tradingSlugFromLiveShortcut(live, '5m')).toBe('eth-updown-5m-900');
    expect(tradingSlugFromLiveShortcut(live, '15m')).toBe(live);
  });

  it('falls back to live when prior bucket missing', () => {
    const live = 'btc-updown-5m-300';
    const prior = nextUpdownSlug(live, -1);
    expect(prior).toBe('btc-updown-5m-0');
    expect(tradingSlugFromLiveShortcut(live, '5m')).toBe('btc-updown-5m-0');
  });

  it('infers hourly bucket from titled slug + endDate', () => {
    const slug = 'bitcoin-up-or-down-april-27-2026-5pm-et';
    const hint = inferUpdownHintFromMarketJson(slug, { endDate: '2026-04-27T22:00:00.000Z' });
    expect(hint?.asset).toBe('btc');
    expect(hint?.interval).toBe('1h');
    expect(hint?.bucketStartSec).toBe(Math.floor(Date.parse('2026-04-27T22:00:00.000Z') / 1000) - 3600);
  });

  it('parseUpdownSlugWithHints restores parse for titled slugs', () => {
    const slug = 'bitcoin-up-or-down-on-april-28-2026';
    const endMs = Date.parse('2026-04-28T16:00:00.000Z');
    const bucket = Math.floor(endMs / 1000) - 86400;
    const p = parseUpdownSlugWithHints(slug, {
      [slug]: { asset: 'btc', interval: '1d', bucketStartSec: bucket },
    });
    expect(p?.interval).toBe('1d');
    expect(p?.ts).toBe(bucket);
  });
});
