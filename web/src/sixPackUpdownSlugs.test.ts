import { describe, expect, it } from 'vitest';
import {
  inferUpdownHintFromMarketJson,
  isTitledUpdownSlug,
  isUpdownDeskMarket,
  nextUpdownSlug,
  parseUpdownSlug,
  parseUpdownSlugWithHints,
  slugFromUpdownShortcutResponse,
  tradingSlugFromLiveShortcut,
  updownSlugAtBucket,
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

  it('prefers API trading_slug over client prior-bucket guess', () => {
    const live = 'btc-updown-5m-1778940000';
    expect(slugFromUpdownShortcutResponse({ slug: live, trading_slug: live }, '5m')).toBe(live);
    expect(slugFromUpdownShortcutResponse({ slug: live, trading_slug: 'btc-updown-5m-1778939700' }, '5m')).toBe(
      'btc-updown-5m-1778939700',
    );
  });

  it('infers hourly bucket from titled slug + endDate', () => {
    const slug = 'bitcoin-up-or-down-april-27-2026-5pm-et';
    const hint = inferUpdownHintFromMarketJson(slug, { endDate: '2026-04-27T22:00:00.000Z' });
    expect(hint?.asset).toBe('btc');
    expect(hint?.interval).toBe('1h');
    expect(hint?.bucketStartSec).toBe(Math.floor(Date.parse('2026-04-27T22:00:00.000Z') / 1000) - 3600);
  });

  it('isUpdownDeskMarket accepts titled hourly slugs', () => {
    expect(isUpdownDeskMarket('bitcoin-up-or-down-may-16-2026-4pm-et')).toBe(true);
    expect(isUpdownDeskMarket('random-market-slug')).toBe(false);
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

  it('infers 4h bucket from eventStartTime on canonical slug market json', () => {
    const hint = inferUpdownHintFromMarketJson('btc-updown-4h-1781121600', {
      endDate: '2026-06-11T00:00:00Z',
      eventStartTime: '2026-06-10T20:00:00Z',
    });
    expect(hint?.interval).toBe('4h');
    expect(hint?.bucketStartSec).toBe(1_781_121_600);
  });

  it('steps titled hourly slugs with hints', () => {
    const slug = 'bitcoin-up-or-down-june-10-2026-7pm-et';
    const bucket = 1_781_132_400; // 7pm ET Jun 10 2026
    const hints = { [slug]: { asset: 'btc' as const, interval: '1h' as const, bucketStartSec: bucket } };
    expect(isTitledUpdownSlug(slug)).toBe(true);
    const next = nextUpdownSlug(slug, 1, hints);
    expect(next).toBe(updownSlugAtBucket('btc', '1h', bucket + 3600, true));
    expect(next).toMatch(/8pm-et$/);
    const prev = nextUpdownSlug(slug, -1, hints);
    expect(prev).toBe(updownSlugAtBucket('btc', '1h', bucket - 3600, true));
    expect(prev).toMatch(/6pm-et$/);
  });

  it('steps titled daily slugs with hints', () => {
    const slug = 'bitcoin-up-or-down-on-june-11-2026';
    const bucket = 1_781_107_200; // noon ET Jun 10 → resolves Jun 11
    const hints = { [slug]: { asset: 'btc' as const, interval: '1d' as const, bucketStartSec: bucket } };
    expect(updownSlugAtBucket('btc', '1d', bucket, true)).toBe(slug);
    const next = nextUpdownSlug(slug, 1, hints);
    expect(next).toBe('bitcoin-up-or-down-on-june-12-2026');
    const prev = nextUpdownSlug(slug, -1, hints);
    expect(prev).toBe('bitcoin-up-or-down-on-june-10-2026');
  });
});
