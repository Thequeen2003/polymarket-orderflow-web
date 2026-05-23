/**
 * Cancel resting live orders + sync local trade history / open-order UI.
 */

import { formatTradeApiError } from './formatTradeApiError';
import { tradeCancelAllOrders, tradeCancelOrder, type ApiErr, type ApiOk } from './lib/api';
import { isRestingLiveOrderRow } from './tradeHistoryDisplay';
import { loadTradeHistory, updateTradeHistoryRow, type TradeHistoryRow } from './tradeHistory';

function isOk<T>(res: ApiOk<T> | ApiErr): res is ApiOk<T> {
  return res.ok === true;
}

export function markLiveOrdersCancelledById(orderId: string): number {
  const oid = orderId.trim();
  if (!oid) return 0;
  let n = 0;
  for (const r of loadTradeHistory()) {
    if (r.mode !== 'live' || r.orderId?.trim() !== oid) continue;
    if (r.status === 'cancelled' || r.status === 'failed' || r.status === 'no_fill') continue;
    updateTradeHistoryRow(r.id, {
      status: 'cancelled',
      remainingShares: 0,
      shares: 0,
      auditNote: r.auditNote ? `${r.auditNote} · user_cancel` : 'user_cancel',
    });
    n += 1;
  }
  return n;
}

export function markAllRestingLiveOrdersCancelled(): number {
  let n = 0;
  for (const r of loadTradeHistory()) {
    if (!isRestingLiveOrderRow(r)) continue;
    updateTradeHistoryRow(r.id, {
      status: 'cancelled',
      remainingShares: 0,
      shares: 0,
      auditNote: r.auditNote ? `${r.auditNote} · cancel_all` : 'cancel_all',
    });
    n += 1;
  }
  return n;
}

export type CancelLiveOrderResult =
  | { ok: true; idempotent?: boolean }
  | { ok: false; message: string };

export async function cancelOneLiveOrder(orderId: string): Promise<CancelLiveOrderResult> {
  const oid = orderId.trim();
  if (!oid) return { ok: false, message: 'missing order id' };
  const res = await tradeCancelOrder(oid);
  if (!isOk(res)) return { ok: false, message: formatTradeApiError(res) };
  const idempotent = Boolean((res.data as { idempotent?: boolean } | undefined)?.idempotent);
  markLiveOrdersCancelledById(oid);
  return { ok: true, idempotent };
}

export type CancelAllLiveOrdersResult =
  | { ok: true; count: number | null; canceledIds: string[] }
  | { ok: false; message: string };

export async function cancelAllLiveOrders(): Promise<CancelAllLiveOrdersResult> {
  const res = await tradeCancelAllOrders();
  if (!isOk(res)) return { ok: false, message: formatTradeApiError(res) };
  const data = res.data as Record<string, unknown> | null;
  const canceledIds = Array.isArray(data?.canceled)
    ? (data!.canceled as unknown[]).map((x) => String(x).trim()).filter(Boolean)
    : [];
  const count =
    typeof data?.count === 'number' && Number.isFinite(data.count)
      ? data.count
      : canceledIds.length > 0
        ? canceledIds.length
        : null;
  markAllRestingLiveOrdersCancelled();
  for (const oid of canceledIds) markLiveOrdersCancelledById(oid);
  return { ok: true, count, canceledIds };
}

/** Whether the row still has a resting remainder worth cancelling on-exchange. */
export function liveRowCancelable(row: Pick<TradeHistoryRow, 'mode' | 'status' | 'orderId' | 'remainingShares'>): boolean {
  if (row.mode !== 'live') return false;
  if (!row.orderId?.trim()) return false;
  if (row.status === 'cancelled' || row.status === 'failed' || row.status === 'no_fill') return false;
  if (row.status === 'sent' || row.status === 'sending' || row.status === 'pending' || row.status === 'submitted') {
    return true;
  }
  if (row.status === 'partial') {
    const rem = row.remainingShares;
    return rem == null || rem > 1e-6;
  }
  return false;
}
