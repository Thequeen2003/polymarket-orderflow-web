import { describe, expect, it } from 'vitest';
import { isFakNoMatchMessage } from './liveBracketExit';

describe('isFakNoMatchMessage', () => {
  it('detects Bullpen FAK kill text', () => {
    expect(
      isFakNoMatchMessage(
        'bullpen_trade_failed — no orders found to match with FAK order. FAK orders are partially filled or killed',
      ),
    ).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isFakNoMatchMessage('outcome_token_lane_mismatch')).toBe(false);
  });
});
