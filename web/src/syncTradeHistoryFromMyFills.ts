/**
 * Align local trade-history rows with confirmed CLOB my-fills (VWAP per order id).
 * Complements `reconcileTradeHistoryFromClob` — runs immediately when fills refresh.
 */

import type { MyFillRow } from './lib/api';
import { loadTradeHistory, saveTradeHistory, TRADE_HISTORY_MAX_ROWS, type TradeHistoryRow } from './tradeHistory';
import { pruneDuplicateLiveFillsInHistory } from './tradeHistoryDedupe';
import { roundPrice01, roundShares4 } from './tradingRound';

const SHARE_EPS = 1e-4;
const PRICE_EPS = 5e-6;

export type FillTapeAgg = {
  sumPxSh: number;
  sumSh: number;
  lastMs: number;
  side: 'buy' | 'sell';
};

function mergeAudit(prev: string | undefined, tag: string): string | undefined {
  const p = (prev ?? '').trim();
  if (!p) return tag;
  if (p.includes(tag)) return p;
  return `${p} · ${tag}`;
}

function isRestingStatus(status: TradeHistoryRow['status']): boolean {
  return status === 'sent' || status === 'sending' || status === 'pending' || status === 'submitted';
}

/** VWAP + total shares per order id for one token. */
export function aggregateMyFillsByOrderId(fills: MyFillRow[], tokenId: string): Map<string, FillTapeAgg> {
  const tid = tokenId.trim();
  const map = new Map<string, FillTapeAgg>();
  if (!tid) return map;
  for (const f of fills) {
    if (f.token_id.trim() !== tid) continue;
    const oid = String(f.order_id ?? '').trim();
    if (!oid) continue;
    const cur = map.get(oid) ?? { sumPxSh: 0, sumSh: 0, lastMs: 0, side: f.side };
    cur.sumPxSh += f.price_01 * f.shares;
    cur.sumSh += f.shares;
    cur.lastMs = Math.max(cur.lastMs, f.match_time_ms ?? 0);
    cur.side = f.side;
    map.set(oid, cur);
  }
  return map;
}

/**
 * Patch live rows when tape shares/price differ slightly from local history.
 * Returns number of rows updated.
 */
export function syncTradeHistoryFromMyFills(fills: MyFillRow[], tokenId: string): number {
  const tid = tokenId.trim();
  if (!tid || !fills.length) return 0;

  const byOid = aggregateMyFillsByOrderId(fills, tid);
  if (byOid.size === 0) return 0;

  const rows = loadTradeHistory();
  const changedIds = new Set<string>();
  let updates = 0;

  const next: TradeHistoryRow[] = rows.map((row) => {
    if (row.mode !== 'live' || row.token.trim() !== tid) return row;
    const oid = row.orderId?.trim();
    if (!oid) return row;
    const agg = byOid.get(oid);
    if (!agg || !(agg.sumSh > SHARE_EPS)) return row;
    if (agg.side !== row.side) return row;

    const sh = roundShares4(agg.sumSh);
    const px = roundPrice01(agg.sumPxSh / Math.max(agg.sumSh, 1e-12));
    if (!Number.isFinite(sh) || sh <= 0 || !Number.isFinite(px) || px <= 0 || px >= 1) return row;

    const req =
      row.requestedShares != null && row.requestedShares > 0
        ? row.requestedShares
        : row.shares != null && row.shares > 0 && isRestingStatus(row.status)
          ? row.shares
          : row.shares != null && row.shares > 0
            ? row.shares
            : null;
    const isFull = req == null || !(req > 0) || sh + SHARE_EPS >= req;
    const nextStatus: 'filled' | 'partial' = isFull ? 'filled' : 'partial';

    const patchable =
      row.status === 'filled' ||
      row.status === 'partial' ||
      isRestingStatus(row.status) ||
      row.status === 'cancelled';
    if (!patchable) return row;

    const same =
      row.status === nextStatus &&
      row.shares != null &&
      Math.abs(row.shares - sh) < SHARE_EPS &&
      row.fillAvgPrice01 != null &&
      Math.abs(row.fillAvgPrice01 - px) < PRICE_EPS;

    if (same) return row;

    changedIds.add(row.id);
    updates += 1;
    return {
      ...row,
      status: nextStatus,
      shares: sh,
      fillAvgPrice01: px,
      price01: px,
      usdCents: Math.abs(Math.round(px * sh * 100)),
      requestedShares: row.requestedShares ?? req ?? undefined,
      remainingShares: req != null && req > 0 && !isFull ? Math.max(0, roundShares4(req - sh)) : 0,
      submittedPrice01: row.submittedPrice01 ?? px,
      ts: Math.max(row.ts ?? 0, agg.lastMs),
      auditNote: mergeAudit(row.auditNote, 'my_fills_sync'),
    };
  });

  if (changedIds.size === 0) return 0;

  const latest = loadTradeHistory();
  const patchById = new Map(next.filter((r) => changedIds.has(r.id)).map((r) => [r.id, r] as const));
  const merged = latest.map((r) => patchById.get(r.id) ?? r);
  saveTradeHistory(merged.slice(0, TRADE_HISTORY_MAX_ROWS));
  pruneDuplicateLiveFillsInHistory(tid);
  return updates;
}
