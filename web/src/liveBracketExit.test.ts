import { describe, expect, it } from 'vitest';
import { isFakNoMatchMessage, shouldRetryFakAtBookBid } from './liveBracketExit';

describe('isFakNoMatchMessage', () => {
  it('detects Bullpen FAK kill text', () => {
    expect(
      isFakNoMatchMessage(
        'bullpen_trade_failed — no orders found to match with FAK order. FAK orders are partially filled or killed',
      ),
    ).toBe(true);
  });

  it('detects broader liquidity/no-match wording for market fallback', () => {
    expect(isFakNoMatchMessage('Could not match a market order after a book-based retry')).toBe(true);
    expect(isFakNoMatchMessage('not enough liquidity at requested price')).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isFakNoMatchMessage('outcome_token_lane_mismatch')).toBe(false);
  });

  it('retries TP FAK at refreshed bid when bid can satisfy the floor', () => {
    expect(
      shouldRetryFakAtBookBid({
        currentBid01: 0.62,
        currentPrice01: 0.6,
        floor01: 0.6,
      }),
    ).toEqual({ retry: true, price01: 0.61 });
  });

  it('does not retry below the TP floor', () => {
    expect(
      shouldRetryFakAtBookBid({
        currentBid01: 0.59,
        currentPrice01: 0.6,
        floor01: 0.6,
      }),
    ).toEqual({ retry: false });
  });
});
