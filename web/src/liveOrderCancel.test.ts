import { describe, expect, it } from 'vitest';
import { liveRowCancelable } from './liveOrderCancel';

describe('liveOrderCancel', () => {
  it('liveRowCancelable is true for sent with oid', () => {
    expect(liveRowCancelable({ mode: 'live', status: 'sent', orderId: '0xabc', remainingShares: 5 })).toBe(true);
  });

  it('liveRowCancelable is false for cancelled', () => {
    expect(liveRowCancelable({ mode: 'live', status: 'cancelled', orderId: '0xabc', remainingShares: 0 })).toBe(
      false,
    );
  });

  it('liveRowCancelable is false for filled with no remainder', () => {
    expect(liveRowCancelable({ mode: 'live', status: 'filled', orderId: '0xabc', remainingShares: 0 })).toBe(false);
  });
});
