import { describe, expect, it } from 'vitest';
import { isVerifiedExchangeFill, patchFromGetOrderMatch, verifiedFillFromExecution } from './liveTradeTruth';

describe('liveTradeTruth', () => {
  it('rejects unknown or missing fill', () => {
    expect(isVerifiedExchangeFill(undefined)).toBe(false);
    expect(
      isVerifiedExchangeFill({
        order_id: 'x',
        fill: { status: 'unknown', filled_shares: 5, avg_fill_price_01: 0.5 },
      }),
    ).toBe(false);
  });

  it('accepts server fill with shares and price', () => {
    const v = verifiedFillFromExecution(
      {
        order_id: 'ord-1',
        fill: { status: 'filled', filled_shares: 12.5, avg_fill_price_01: 0.54 },
      },
      {},
    );
    expect(v).toEqual({
      shares: 12.5,
      avg01: 0.54,
      rowStatus: 'filled',
      orderId: 'ord-1',
    });
  });

  it('does not invent fill from empty execution', () => {
    expect(verifiedFillFromExecution(undefined, { orderID: 'ghost' })).toBeNull();
  });

  it('patchFromGetOrderMatch builds filled row from terminal getOrder', () => {
    const p = patchFromGetOrderMatch({
      matched: 5,
      orig: 5,
      avg01: 0.5,
      limit01: 0.5,
      isTerminal: true,
    });
    expect(p?.status).toBe('filled');
    expect(p?.fillAvgPrice01).toBeCloseTo(0.5, 6);
    expect(p?.shares).toBe(5);
    expect(p?.remainingShares).toBe(0);
  });
});
