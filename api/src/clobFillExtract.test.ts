import { describe, expect, it } from 'vitest';
import { extractCanonicalMarketFill } from './clobFillExtract.js';

describe('extractCanonicalMarketFill', () => {
  it('returns unknown for open/unfilled resting ack (no phantom fill)', () => {
    const fill = extractCanonicalMarketFill(
      {
        status: 'UNFILLED',
        size: 10,
        price: 0.55,
        size_matched: 0,
      },
      { side: 'buy', amount: 10 },
    );
    expect(fill.status).toBe('unknown');
    expect(fill.filled_shares).toBeNull();
    expect(fill.avg_fill_price_01).toBeNull();
  });

  it('returns unknown when only order size + limit price present (no match evidence)', () => {
    const fill = extractCanonicalMarketFill(
      { result: { success: true }, size: 5, price: 0.48 },
      { side: 'sell', amount: 5 },
    );
    expect(fill.status).toBe('unknown');
    expect(fill.filled_shares).toBeNull();
  });

  it('accepts maker-order VWAP as fill evidence', () => {
    const fill = extractCanonicalMarketFill(
      {
        status: 'MATCHED',
        maker_orders: [{ price: 0.52, matched_amount: 4, asset_id: 'tok1' }],
      },
      { side: 'sell', amount: 4, tokenID: 'tok1' },
    );
    expect(fill.status).toBe('filled');
    expect(fill.filled_shares).toBe(4);
    expect(fill.avg_fill_price_01).toBeCloseTo(0.52, 6);
  });
});
