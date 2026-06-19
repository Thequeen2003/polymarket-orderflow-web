import { describe, expect, it } from 'vitest';
import { bullpenCashBalanceFromRoot, findBullpenPositionRow, positionAvgEntry01 } from './bullpenReads.js';
import { normalizeBullpenOutcomeName } from './bullpenOutcome.js';

describe('bullpenReads', () => {
  it('reads cash_balance from positions summary', () => {
    expect(
      bullpenCashBalanceFromRoot({
        positions: [],
        summary: { cash_balance: 6.197918 },
      }),
    ).toBeCloseTo(6.197918);
  });

  it('matches slug and Up/Down outcomes', () => {
    const positions = [
      {
        slug: 'btc-updown-5m-123',
        outcome: 'Up',
        size: 12.5,
        asset_id: 'tok-up',
      },
    ];
    const hit = findBullpenPositionRow(positions, {
      marketSlug: 'btc-updown-5m-123',
      outcome: 'Yes',
      tokenId: 'tok-up',
    });
    expect(hit?.size).toBe(12.5);
    expect(normalizeBullpenOutcomeName('Yes')).toBe('Yes');
    expect(normalizeBullpenOutcomeName('Up')).toBe('Up');
  });

  it('positionAvgEntry01 prefers cost basis over mark mislabeled as avg_price', () => {
    expect(positionAvgEntry01({ avg_entry: 47 })).toBeCloseTo(0.47, 6);
    expect(positionAvgEntry01({ avg_price: 53, cur_price: 53 })).toBeNull();
    expect(positionAvgEntry01({ avg_entry: 47, avg_price: 53 })).toBeCloseTo(0.47, 6);
  });

  it('positionAvgEntry01 uses invested_usd and keeps entry when mark is close after fill', () => {
    expect(
      positionAvgEntry01({
        shares: 7.29,
        invested_usd: 6.9984,
        avg_price: 0.96,
        current_price: 0.965,
      }),
    ).toBeCloseTo(6.9984 / 7.29, 4);
    expect(
      positionAvgEntry01({
        avg_price: 0.96,
        current_price: 0.965,
      }),
    ).toBeCloseTo(0.96, 4);
  });
});
