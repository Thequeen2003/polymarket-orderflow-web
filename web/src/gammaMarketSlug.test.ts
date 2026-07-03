import { describe, expect, it } from 'vitest';
import { pickMarketSlug, preloadedMarketForSlug } from './gammaMarketSlug';

describe('preloadedMarketForSlug', () => {
  it('returns market when Gamma slug matches open slug', () => {
    const market = { slug: 'btc-updown-5m-100', clobTokenIds: '["a","b"]' };
    expect(preloadedMarketForSlug(market, 'btc-updown-5m-100')).toBe(market);
  });

  it('rejects market when shortcut trading slug differs from embedded market slug', () => {
    const market = { slug: 'btc-updown-5m-200', clobTokenIds: '["a","b"]' };
    expect(preloadedMarketForSlug(market, 'btc-updown-5m-100')).toBeUndefined();
    expect(pickMarketSlug(market)).toBe('btc-updown-5m-200');
  });
});
