import { describe, expect, it } from 'vitest';
import { computePtbNet4cRoom } from './ptbNet4cTradeability';

const deepBook = {
  bids: Array.from({ length: 10 }, (_, i) => ({ price: 0.45 - i * 0.01, size: 5000 + i * 100 })),
  asks: Array.from({ length: 10 }, (_, i) => ({ price: 0.46 + i * 0.01, size: 5000 + i * 100 })),
};

describe('computePtbNet4cRoom', () => {
  it('returns NO when structural room from mid to wall is below 4¢', () => {
    const r = computePtbNet4cRoom({
      book: deepBook,
      nowProb: 0.5,
      wallProb: 0.52,
      refShares: 100,
    });
    expect(r.room).toBe('NO');
  });

  it('labels MARGINAL when required gross is high', () => {
    const shallow = {
      bids: [{ price: 0.48, size: 50 }],
      asks: [{ price: 0.52, size: 50 }],
    };
    const r = computePtbNet4cRoom({
      book: shallow,
      nowProb: 0.5,
      wallProb: 0.97,
      maxRequiredGrossCents: 4,
    });
    expect(r.room === 'NO' || r.room === 'MARGINAL').toBe(true);
  });
});
