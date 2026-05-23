import { describe, expect, it } from 'vitest';
import {
  isCanonicalUpdownSlug,
  laneForTokenInMarket,
  normalizeBullpenOutcomeName,
  resolveBullpenOrderOutcome,
  resolveBullpenOutcome,
} from './bullpenOutcome.js';

describe('bullpenOutcome', () => {
  it('detects canonical updown slugs', () => {
    expect(isCanonicalUpdownSlug('btc-updown-5m-1778978100')).toBe(true);
    expect(isCanonicalUpdownSlug('will-trump-win')).toBe(false);
  });

  it('normalizes decorative labels', () => {
    expect(normalizeBullpenOutcomeName('BTC Up')).toBe('Up');
    expect(normalizeBullpenOutcomeName('bitcoin down')).toBe('Down');
    expect(normalizeBullpenOutcomeName('Yes')).toBe('Yes');
  });

  it('maps Yes/No to Up/Down on updown slugs', () => {
    expect(
      resolveBullpenOutcome({
        outcome: 'Yes',
        marketSlug: 'btc-updown-5m-1778978100',
        lane: 'up',
      }),
    ).toBe('Up');
    expect(
      resolveBullpenOutcome({
        outcome: 'NO',
        marketSlug: 'btc-updown-5m-1778978100',
        lane: 'down',
      }),
    ).toBe('Down');
  });

  it('keeps Yes/No on binary slugs', () => {
    expect(
      resolveBullpenOutcome({
        outcome: 'Yes',
        marketSlug: 'microstrategy-announces-1000-btc-purchase-may-12-18',
        lane: 'up',
      }),
    ).toBe('Yes');
  });

  it('resolves Bullpen outcome from token index on canonical updown', () => {
    const market = {
      slug: 'btc-updown-5m-1778978100',
      outcomes: '["Up","Down"]',
      clobTokenIds: '["tok-up","tok-down"]',
    };
    expect(laneForTokenInMarket(market, 'tok-down')).toBe('down');
    const r = resolveBullpenOrderOutcome({
      tokenId: 'tok-down',
      marketSlug: 'btc-updown-5m-1778978100',
      lane: 'down',
      outcomeHint: 'Up',
      market,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.outcome).toBe('Down');
  });

  it('rejects lane/token mismatch before Bullpen submit', () => {
    const market = {
      slug: 'btc-updown-5m-1778978100',
      outcomes: '["Up","Down"]',
      clobTokenIds: '["tok-up","tok-down"]',
    };
    const r = resolveBullpenOrderOutcome({
      tokenId: 'tok-up',
      marketSlug: 'btc-updown-5m-1778978100',
      lane: 'down',
      outcomeHint: 'Down',
      market,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('outcome_token_lane_mismatch');
  });
});
