import { describe, expect, it } from 'vitest';
import { loadTradeHistory, saveTradeHistory, type TradeHistoryRow } from './tradeHistory';
import { aggregateMyFillsByOrderId, syncTradeHistoryFromMyFills } from './syncTradeHistoryFromMyFills';
import type { MyFillRow } from './lib/api';
import { installMockLocalStorage } from './test/mockLocalStorage';

installMockLocalStorage();

function row(partial: Partial<TradeHistoryRow>): TradeHistoryRow {
  return {
    id: 'r1',
    ts: Date.now(),
    mode: 'live',
    exec: 'limit',
    side: 'buy',
    token: 'tok-a',
    label: 'Up',
    price01: 0.5,
    shares: 4.99,
    requestedShares: 5,
    remainingShares: 0,
    fillAvgPrice01: 0.5,
    usdCents: 250,
    status: 'filled',
    orderId: 'ord-1',
    ...partial,
  };
}

describe('syncTradeHistoryFromMyFills', () => {
  it('aggregates multiple prints per order', () => {
    const fills: MyFillRow[] = [
      { token_id: 'tok-a', order_id: 'o1', side: 'buy', price_01: 0.5, shares: 2, match_time_ms: 1, role: 'taker' },
      { token_id: 'tok-a', order_id: 'o1', side: 'buy', price_01: 0.52, shares: 3, match_time_ms: 2, role: 'maker' },
    ];
    const agg = aggregateMyFillsByOrderId(fills, 'tok-a');
    expect(agg.get('o1')?.sumSh).toBe(5);
    expect(agg.get('o1')?.sumPxSh).toBeCloseTo(0.5 * 2 + 0.52 * 3, 8);
  });

  it('corrects filled row shares when tape differs slightly', () => {
    saveTradeHistory([row({ shares: 4.99, fillAvgPrice01: 0.5 })]);
    const fills: MyFillRow[] = [
      { token_id: 'tok-a', order_id: 'ord-1', side: 'buy', price_01: 0.51, shares: 5, match_time_ms: 99, role: 'taker' },
    ];
    const n = syncTradeHistoryFromMyFills(fills, 'tok-a');
    expect(n).toBe(1);
    const updated = loadTradeHistory()[0]!;
    expect(updated.shares).toBe(5);
    expect(updated.fillAvgPrice01).toBeCloseTo(0.51, 6);
    expect(updated.auditNote).toContain('my_fills_sync');
  });
});
