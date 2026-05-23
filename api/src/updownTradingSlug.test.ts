import { describe, expect, it } from 'vitest';
import { priorCanonicalUpdownSlug } from './updownTradingSlug.js';

describe('updownTradingSlug', () => {
  it('derives prior 5m canonical slug', () => {
    expect(priorCanonicalUpdownSlug('btc-updown-5m-1778940000')).toBe('btc-updown-5m-1778939700');
    expect(priorCanonicalUpdownSlug('eth-updown-5m-300')).toBe('eth-updown-5m-0');
  });

  it('returns null for non-canonical slugs', () => {
    expect(priorCanonicalUpdownSlug('bitcoin-up-or-down-on-may-16-2026')).toBeNull();
    expect(priorCanonicalUpdownSlug('btc-updown-15m-1000')).toBeNull();
  });
});
