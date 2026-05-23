import { describe, expect, it } from 'vitest';
import { loadTradeHistory, saveTradeHistory, type TradeHistoryRow } from './tradeHistory';
import type { MyFillRow } from './lib/api';
import { installMockLocalStorage } from './test/mockLocalStorage';
import {
  dedupeFilledRowsByOrderId,
  mergeRecentFillsForDisplay,
  pruneDuplicateLiveFillsInHistory,
} from './tradeHistoryDedupe';

installMockLocalStorage();

function row(partial: Partial<TradeHistoryRow>): TradeHistoryRow {
  return {
    id: 'r1',
    ts: 1000,
    mode: 'live',
    exec: 'limit',
    side: 'buy',
    token: 'tok-a',
    label: 'Up',
    price01: 0.63,
    shares: 5,
    fillAvgPrice01: 0.63,
    usdCents: 315,
    status: 'filled',
    ...partial,
  };
}

describe('tradeHistoryDedupe', () => {
  it('keeps one row per order id (best quality)', () => {
    const out = dedupeFilledRowsByOrderId([
      row({ id: 'old', orderId: 'oid-1', fillAvgPrice01: 0.63, submittedPrice01: null }),
      row({
        id: 'new',
        orderId: 'oid-1',
        fillAvgPrice01: 0.63,
        submittedPrice01: 0.63,
        auditNote: 'clob_tape_reconcile',
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('new');
  });

  it('drops orphan without oid when same fill as keyed row', () => {
    const out = dedupeFilledRowsByOrderId([
      row({ id: 'orphan', orderId: undefined, ts: 1000 }),
      row({ id: 'good', orderId: 'oid-1', ts: 1005, submittedPrice01: 0.63 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('good');
  });

  it('mergeRecentFillsForDisplay does not duplicate local + tape for same oid', () => {
    const local = [row({ id: 'local-1', orderId: 'oid-1', fillAvgPrice01: 0.69 })];
    const fills: MyFillRow[] = [
      {
        token_id: 'tok-a',
        order_id: 'oid-1',
        side: 'buy',
        price_01: 0.69,
        shares: 5,
        match_time_ms: 2000,
        role: 'taker',
      },
    ];
    const merged = mergeRecentFillsForDisplay({
      localFilled: local,
      myFills: fills,
      tokenId: 'tok-a',
      mode: 'live',
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.orderId).toBe('oid-1');
  });

  it('pruneDuplicateLiveFillsInHistory removes extra storage rows', () => {
    saveTradeHistory([
      row({ id: 'a', orderId: 'oid-x' }),
      row({ id: 'b', orderId: 'oid-x', submittedPrice01: 0.63, auditNote: 'clob_tape' }),
    ]);
    const n = pruneDuplicateLiveFillsInHistory('tok-a');
    expect(n).toBe(1);
    expect(loadTradeHistory()).toHaveLength(1);
    expect(loadTradeHistory()[0]!.id).toBe('b');
  });
});
