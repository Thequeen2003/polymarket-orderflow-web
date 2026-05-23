import { describe, expect, it } from 'vitest';
import { filterRestingOpenOrders, isRestingOpenOrder } from './openOrderNormalize.js';

describe('isRestingOpenOrder', () => {
  it('keeps LIVE and OPEN', () => {
    expect(isRestingOpenOrder({ status: 'LIVE' })).toBe(true);
    expect(isRestingOpenOrder({ status: 'OPEN' })).toBe(true);
  });

  it('drops filled and cancelled', () => {
    expect(isRestingOpenOrder({ status: 'FILLED' })).toBe(false);
    expect(isRestingOpenOrder({ status: 'CANCELLED' })).toBe(false);
    expect(isRestingOpenOrder({ status: 'MATCHED' })).toBe(false);
  });
});

describe('filterRestingOpenOrders', () => {
  it('filters terminal orders', () => {
    const out = filterRestingOpenOrders([
      { id: 'a', status: 'LIVE', size: 5 },
      { id: 'b', status: 'FILLED', size: 5 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('a');
  });
});
