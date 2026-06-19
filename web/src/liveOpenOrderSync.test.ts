import { describe, expect, it, vi } from 'vitest';
import { loadTradeHistory, saveTradeHistory, type TradeHistoryRow } from './tradeHistory';
import {
  OPEN_ORDER_ABSENT_STALE_MS,
  localLiveOrderAbsentFromOpenOrders,
  syncSentRowsFromOpenOrders,
} from './liveOpenOrderSync';
import { installMockLocalStorage } from './test/mockLocalStorage';

installMockLocalStorage();

function row(partial: Partial<TradeHistoryRow>): TradeHistoryRow {
  return {
    id: 'r1',
    ts: Date.now() - OPEN_ORDER_ABSENT_STALE_MS - 100,
    mode: 'live',
    exec: 'limit',
    side: 'buy',
    token: 'tok-a',
    label: 'Up',
    price01: 0.6,
    submittedPrice01: 0.6,
    shares: 0,
    requestedShares: 5,
    remainingShares: 5,
    usdCents: 300,
    status: 'sent',
    orderId: 'ord-1',
    ...partial,
  };
}

describe('liveOpenOrderSync', () => {
  it('does not retire a local order during the fresh open-order lag window', () => {
    const nowMs = 10_000;
    expect(
      localLiveOrderAbsentFromOpenOrders(
        row({ ts: nowMs - OPEN_ORDER_ABSENT_STALE_MS + 1 }),
        new Set<string>(),
        nowMs,
      ),
    ).toBe(false);
  });

  it('marks stale local live orders no_fill when absent from open orders', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T12:00:00Z'));
    saveTradeHistory([row({ ts: Date.now() - OPEN_ORDER_ABSENT_STALE_MS - 100 })]);

    const n = syncSentRowsFromOpenOrders([]);

    expect(n).toBe(1);
    const updated = loadTradeHistory()[0]!;
    expect(updated.status).toBe('no_fill');
    expect(updated.remainingShares).toBe(0);
    expect(updated.shares).toBe(0);
    expect(updated.auditNote).toContain('open_orders_absent');
    vi.useRealTimers();
  });

  it('keeps local rows active when the order appears in the open-order snapshot', () => {
    saveTradeHistory([row({ orderId: 'ord-1', remainingShares: 5 })]);

    const n = syncSentRowsFromOpenOrders([{ id: 'ord-1', original_size: 5, remaining: 5, price: 0.6 }]);

    expect(n).toBe(0);
    expect(loadTradeHistory()[0]!.status).toBe('sent');
  });
});
