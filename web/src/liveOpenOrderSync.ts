/**
 * Keep local `sent` trade-history rows aligned with Bullpen/CLOB open-order snapshots.
 */

import {
  loadTradeHistory,
  saveTradeHistory,
  TRADE_HISTORY_MAX_ROWS,
  updateTradeHistoryRow,
  type TradeHistoryRow,
} from './tradeHistory';
import { rowShowsExchangeFill } from './liveTradeTruth';
import { roundPrice01 } from './tradingRound';

export const OPEN_ORDER_ABSENT_STALE_MS = 5_000;

function asNum(x: unknown): number | null {
  const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
}

function asStr(x: unknown): string | null {
  return typeof x === 'string' && x.trim() ? x : null;
}

export function orderIdFromOpenOrder(o: unknown): string | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  return asStr(r.id ?? r.orderID ?? r.orderId ?? r.order_id);
}

function orderPrice01FromOpenOrder(o: unknown): number | null {
  if (!o || typeof o !== 'object') return null;
  const n = asNum((o as Record<string, unknown>).price ?? (o as Record<string, unknown>).price01);
  if (n == null || n <= 0) return null;
  if (n <= 1) return roundPrice01(n);
  if (n <= 100) return roundPrice01(n / 100);
  return null;
}

function orderSizeFromOpenOrder(o: unknown): number | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  return asNum(r.original_size ?? r.originalSize ?? r.size ?? r.total_size ?? r.totalSize);
}

function orderRemainingFromOpenOrder(o: unknown): number | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const rem = asNum(r.remaining ?? r.sizeRemaining ?? r.remaining_size ?? r.remainingSize);
  if (rem != null) return Math.max(0, rem);
  const size = orderSizeFromOpenOrder(o);
  const matched = asNum(r.size_matched ?? r.sizeMatched ?? r.matched_size ?? r.matchedSize);
  if (size != null && matched != null) return Math.max(0, size - matched);
  return size;
}

function isLocalOpenOrderStatus(status: TradeHistoryRow['status']): boolean {
  return status === 'sent' || status === 'sending' || status === 'pending' || status === 'partial';
}

export function localLiveOrderAbsentFromOpenOrders(
  row: Pick<TradeHistoryRow, 'mode' | 'status' | 'orderId' | 'ts'>,
  openOrderIds: ReadonlySet<string>,
  nowMs: number,
  staleMs = OPEN_ORDER_ABSENT_STALE_MS,
): boolean {
  if (row.mode !== 'live') return false;
  const oid = row.orderId?.trim();
  if (!oid) return false;
  if (!isLocalOpenOrderStatus(row.status)) return false;
  if (openOrderIds.has(oid)) return false;
  const ts = Number(row.ts ?? 0);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return nowMs - ts >= staleMs;
}

/** Patch open `sent` rows with exchange remaining / matched (0/5 not 5/5). */
export function syncSentRowsFromOpenOrders(orders: unknown[]): number {
  if (!Array.isArray(orders)) return 0;
  const byOid = new Map<string, { size: number | null; rem: number | null; px: number | null }>();
  for (const o of orders) {
    const oid = orderIdFromOpenOrder(o);
    if (!oid) continue;
    byOid.set(oid, {
      size: orderSizeFromOpenOrder(o),
      rem: orderRemainingFromOpenOrder(o),
      px: orderPrice01FromOpenOrder(o),
    });
  }

  let updates = 0;
  const nowMs = Date.now();
  const rows = loadTradeHistory();
  for (const row of rows) {
    if (row.mode !== 'live') continue;
    const oid = row.orderId?.trim();
    if (!oid) continue;
    if (!isLocalOpenOrderStatus(row.status)) continue;
    if (rowShowsExchangeFill(row)) continue;
    const snap = byOid.get(oid);
    if (!snap) {
      if (!localLiveOrderAbsentFromOpenOrders(row, new Set(byOid.keys()), nowMs)) continue;
      const filled = Math.max(0, Number(row.shares ?? 0));
      updateTradeHistoryRow(row.id, {
        status: filled > 1e-6 ? 'partial' : 'no_fill',
        remainingShares: 0,
        shares: filled,
        auditNote: row.auditNote ? `${row.auditNote} · open_orders_absent` : 'open_orders_absent',
      });
      updates += 1;
      continue;
    }
    const req = snap.size ?? row.requestedShares ?? null;
    const rem = snap.rem ?? row.remainingShares ?? req;
    const matched =
      req != null && rem != null && Number.isFinite(req) && Number.isFinite(rem)
        ? Math.max(0, req - rem)
        : 0;
    const sameRem = row.remainingShares != null && rem != null && Math.abs(row.remainingShares - rem) < 1e-4;
    const sameMatched = row.shares != null && Math.abs(row.shares - matched) < 1e-4;
    if (sameRem && sameMatched) continue;
    updateTradeHistoryRow(row.id, {
      requestedShares: req ?? undefined,
      remainingShares: rem ?? undefined,
      shares: matched,
      submittedPrice01: snap.px ?? row.submittedPrice01 ?? undefined,
      price01: row.price01 ?? snap.px ?? undefined,
    });
    updates += 1;
  }
  if (updates > 0) {
    saveTradeHistory(loadTradeHistory().slice(0, TRADE_HISTORY_MAX_ROWS));
  }
  return updates;
}
