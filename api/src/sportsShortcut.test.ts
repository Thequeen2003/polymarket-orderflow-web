import { describe, expect, it } from 'vitest';
import { isSportsGameSlug, isSportsMarketShape, pickPrimaryGameMarket } from './sportsShortcut.js';

describe('sportsShortcut', () => {
  it('detects sports market shape from slug prefix', () => {
    expect(isSportsMarketShape({ slug: 'mlb-tor-atl-2026-06-04' })).toBe(true);
    expect(isSportsMarketShape({ slug: 'btc-updown-5m-123' })).toBe(false);
    expect(isSportsMarketShape({ gameStartTime: '2026-06-04T00:00:00Z' })).toBe(true);
  });

  it('detects game slugs vs season props', () => {
    expect(isSportsGameSlug('mlb-mia-pit-2026-06-12')).toBe(true);
    expect(isSportsGameSlug('mlb-perfect-game-thrown-in-2026-season')).toBe(false);
  });

  it('picks moneyline market from game event', () => {
    const event = {
      slug: 'mlb-mia-pit-2026-06-12',
      markets: [
        { slug: 'mlb-mia-pit-2026-06-12-spread-home-1pt5', sportsMarketType: 'spread' },
        { slug: 'mlb-mia-pit-2026-06-12', sportsMarketType: 'moneyline', question: 'Miami vs Pittsburgh' },
      ],
    };
    const picked = pickPrimaryGameMarket(event);
    expect(picked?.slug).toBe('mlb-mia-pit-2026-06-12');
  });
});
