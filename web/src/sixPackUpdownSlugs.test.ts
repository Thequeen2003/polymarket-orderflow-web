import { describe, expect, it } from 'vitest';
import { nextUpdownSlug, parseUpdownSlug, tradingSlugFromLiveShortcut } from './sixPackUpdownSlugs';

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
});
