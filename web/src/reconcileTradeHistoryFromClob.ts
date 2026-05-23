import { tradeOrderFillIndex, type ApiErr, type ApiOk } from './lib/api';
import { loadTradeHistory, saveTradeHistory, TRADE_HISTORY_MAX_ROWS, type TradeHistoryRow } from './tradeHistory';
import { roundPrice01, roundShares4 } from './tradingRound';

function isOk<T>(res: ApiOk<T> | ApiErr): res is ApiOk<T> {
  return res.ok === true;
}

export type OrderFillIndexData = {
  token_id: string;
  by_order_id: Record<string, { shares: number; avg_price_01: number; side: string; updated_at_ms: number }>;
};

function mergeAudit(prev: string | undefined, tag: string): string | undefined {
  const p = (prev ?? '').trim();
  if (!p) return tag;
  if (p.includes(tag)) return p;
  return `${p} · ${tag}`;
}

/**
 * Align local trade history with the same CLOB `/data` trades feed Polymarket uses (order id → VWAP fill).
 * Safe to call often; skips rows that already match within a small epsilon.
 *
 * Also promotes `sent` / `sending` / `pending` rows when the tape already shows fills for that order id
 * (market orders + fast TP/SL often land before `getOrder()` reports a terminal status).
 */
export async function reconcileTradeHistoryFromClob(tokenId: string, opts?: { force?: boolean }): Promise<number> {
  const tid = tokenId.trim();
  if (!tid) return 0;

  const res = await tradeOrderFillIndex({ tokenId: tid, force: opts?.force });
  if (!isOk(res)) return 0;

  const { by_order_id: idx } = res.data as OrderFillIndexData;
  if (!idx || typeof idx !== 'object') return 0;

  const rows = loadTradeHistory();
  const EPS = 1e-4;
  const changedIds = new Set<string>();
  let updates = 0;
  const next: TradeHistoryRow[] = rows.map((row) => {
    if (row.mode !== 'live' || row.token.trim() !== tid) return row;
    const oid = row.orderId?.trim();
    if (!oid) return row;
    const hit = idx[oid];
    if (!hit) return row;
    if (String(hit.side).toLowerCase() !== row.side) return row;

    const sh = roundShares4(Number(hit.shares));
    const px = roundPrice01(Number(hit.avg_price_01));
    if (!Number.isFinite(sh) || sh <= 0 || !Number.isFinite(px) || px <= 0 || px >= 1) return row;

    const usd = Math.abs(Math.round(px * sh * 100));
    const req =
      row.requestedShares != null && row.requestedShares > 0
        ? row.requestedShares
        : row.shares != null && row.shares > 0 && (row.status === 'sent' || row.status === 'sending' || row.status === 'pending')
          ? row.shares
          : row.shares != null && row.shares > 0
            ? row.shares
            : null;
    const isFull = req == null || !(req > 0) || sh + EPS >= req;
    const nextStatus = isFull ? 'filled' : 'partial';

    const sameShPx =
      row.shares != null &&
      Math.abs(row.shares - sh) < EPS &&
      row.fillAvgPrice01 != null &&
      Math.abs(row.fillAvgPrice01 - px) < EPS;

    if (row.status === 'filled') {
      if (sameShPx) return row;
      changedIds.add(row.id);
      updates += 1;
      return {
        ...row,
        shares: sh,
        fillAvgPrice01: px,
        price01: px,
        usdCents: usd,
        auditNote: mergeAudit(row.auditNote, 'clob_trade_match'),
      };
    }

    if (row.status === 'partial') {
      if (sameShPx && nextStatus === 'partial') return row;
      if (sameShPx && nextStatus === 'filled') {
        changedIds.add(row.id);
        updates += 1;
        return { ...row, status: 'filled', remainingShares: 0 };
      }
      changedIds.add(row.id);
      updates += 1;
      return {
        ...row,
        status: nextStatus,
        shares: sh,
        fillAvgPrice01: px,
        price01: px,
        usdCents: usd,
        requestedShares: row.requestedShares ?? req ?? undefined,
        remainingShares: req != null && req > 0 && !isFull ? Math.max(0, roundShares4(req - sh)) : 0,
        auditNote: mergeAudit(row.auditNote, 'clob_tape'),
      };
    }

    if (row.status === 'sent' || row.status === 'sending' || row.status === 'pending' || row.status === 'submitted') {
      changedIds.add(row.id);
      updates += 1;
      return {
        ...row,
        status: nextStatus,
        shares: sh,
        fillAvgPrice01: px,
        price01: px,
        usdCents: usd,
        requestedShares: row.requestedShares ?? req ?? undefined,
        remainingShares: req != null && req > 0 && !isFull ? Math.max(0, roundShares4(req - sh)) : 0,
        submittedPrice01: row.submittedPrice01 ?? px,
        auditNote: mergeAudit(row.auditNote, 'clob_tape_reconcile'),
      };
    }

    /**
     * Touch sells can be mis-labeled `cancelled` in local history even when the CLOB tape shows fills
     * (cancel arrives on the resting order after a partial/full match). Promote from tape when possible.
     */
    if (row.status === 'cancelled') {
      changedIds.add(row.id);
      updates += 1;
      return {
        ...row,
        status: nextStatus,
        shares: sh,
        fillAvgPrice01: px,
        price01: px,
        usdCents: usd,
        requestedShares: row.requestedShares ?? req ?? undefined,
        remainingShares: req != null && req > 0 && !isFull ? Math.max(0, roundShares4(req - sh)) : 0,
        submittedPrice01: row.submittedPrice01 ?? px,
        auditNote: mergeAudit(row.auditNote, 'clob_cancel_row_repaired'),
      };
    }

    return row;
  });

  if (changedIds.size === 0) return 0;

  /**
   * `rows` was loaded before an async gap; another tab of logic may have appended rows since then.
   * Never save that stale full list — merge only reconciled ids into the latest snapshot.
   */
  const latest = loadTradeHistory();
  const patchById = new Map(next.filter((r) => changedIds.has(r.id)).map((r) => [r.id, r] as const));
  const merged = latest.map((r) => patchById.get(r.id) ?? r);
  saveTradeHistory(merged.slice(0, TRADE_HISTORY_MAX_ROWS));
  return updates;
}
