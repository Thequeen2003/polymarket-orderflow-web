/**
 * Keep local `sent` trade-history rows aligned with Bullpen/CLOB open-order snapshots.
 */

import { loadTradeHistory, saveTradeHistory, TRADE_HISTORY_MAX_ROWS, updateTradeHistoryRow } from './tradeHistory';
import { rowShowsExchangeFill } from './liveTradeTruth';
import { roundPrice01 } from './tradingRound';

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

/** Patch open `sent` rows with exchange remaining / matched (0/5 not 5/5). */
export function syncSentRowsFromOpenOrders(orders: unknown[]): number {
  if (!Array.isArray(orders) || orders.length === 0) return 0;
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
  if (byOid.size === 0) return 0;

  let updates = 0;
  const rows = loadTradeHistory();
  for (const row of rows) {
    if (row.mode !== 'live') continue;
    const oid = row.orderId?.trim();
    if (!oid) continue;
    if (row.status !== 'sent' && row.status !== 'sending' && row.status !== 'pending') continue;
    if (rowShowsExchangeFill(row)) continue;
    const snap = byOid.get(oid);
    if (!snap) continue;
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
