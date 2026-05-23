import { describe, expect, it } from 'vitest';
import {
  liveOpenOrderDisplayCount,
  orderOriginalSizeFromSnapshot,
  orderRemainingFromSnapshot,
} from './openOrderSizeParse';

describe('orderOriginalSizeFromSnapshot', () => {
  it('uses original_size when present', () => {
    expect(orderOriginalSizeFromSnapshot({ original_size: 10, size: 7, size_matched: 3 })).toBe(10);
  });

  it('does not treat CLOB size as original', () => {
    expect(orderOriginalSizeFromSnapshot({ size: 7, size_matched: 3 })).toBe(10);
  });

  it('treats lone size as remaining only', () => {
    expect(orderOriginalSizeFromSnapshot({ size: 5 })).toBeNull();
  });
});

describe('orderRemainingFromSnapshot', () => {
  it('derives remaining from original minus matched', () => {
    expect(orderRemainingFromSnapshot({ original_size: 10, size_matched: 3 })).toBe(7);
  });

  it('uses size as remaining when original_size is absent', () => {
    expect(orderRemainingFromSnapshot({ size: 7, size_matched: 3 })).toBe(7);
  });

  it('prefers explicit remaining field', () => {
    expect(orderRemainingFromSnapshot({ original_size: 10, remaining: 4, size_matched: 6 })).toBe(4);
  });
});

describe('liveOpenOrderDisplayCount', () => {
  it('does not double-count local rows that match exchange orders', () => {
    const n = liveOpenOrderDisplayCount(
      [{ id: 'abc', original_size: 5 }],
      [{ orderId: 'abc' }, { orderId: 'xyz' }],
    );
    expect(n).toBe(2);
  });

  it('dedupes duplicate exchange order ids', () => {
    const n = liveOpenOrderDisplayCount(
      [
        { id: 'abc', original_size: 5 },
        { id: 'abc', original_size: 5 },
      ],
      [],
    );
    expect(n).toBe(1);
  });
});

describe('open_size fields', () => {
  it('reads open_size as remaining', () => {
    expect(orderRemainingFromSnapshot({ original_size: 10, open_size: 4, size_matched: 6 })).toBe(4);
  });
});
