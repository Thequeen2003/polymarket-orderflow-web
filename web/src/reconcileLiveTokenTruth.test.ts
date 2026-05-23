import { describe, expect, it, vi, beforeEach } from 'vitest';
import { saveTradeHistory, type TradeHistoryRow } from './tradeHistory';
import type { MyFillRow } from './lib/api';
import { installMockLocalStorage } from './test/mockLocalStorage';

installMockLocalStorage();

vi.mock('./reconcileTradeHistoryFromClob.js', () => ({
  reconcileTradeHistoryFromClob: vi.fn(async () => 0),
}));

import { reconcileTradeHistoryFromClob } from './reconcileTradeHistoryFromClob.js';
import { liveTruthChanged, reconcileLiveTokenTruth } from './reconcileLiveTokenTruth';

function row(partial: Partial<TradeHistoryRow>): TradeHistoryRow {
  return {
    id: 'r1',
    ts: 1,
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

describe('reconcileLiveTokenTruth', () => {
  beforeEach(() => {
    vi.mocked(reconcileTradeHistoryFromClob).mockClear();
  });

  it('patches from my-fills before CLOB reconcile', async () => {
    saveTradeHistory([row({ shares: 4.99 })]);
    const fills: MyFillRow[] = [
      { token_id: 'tok-a', order_id: 'ord-1', side: 'buy', price_01: 0.51, shares: 5, match_time_ms: 1, role: 'taker' },
    ];
    const result = await reconcileLiveTokenTruth('tok-a', { fills });
    expect(result.myFillsSync).toBe(1);
    expect(liveTruthChanged(result)).toBe(true);
    expect(reconcileTradeHistoryFromClob).toHaveBeenCalledWith('tok-a', { force: true });
  });
});
