import { tradeOrderFillIndex, type ApiErr, type ApiOk } from './lib/api';
import { loadTradeHistory, saveTradeHistory, type TradeHistoryRow } from './tradeHistory';
import { roundPrice01, roundShares4 } from './tradingRound';

function isOk<T>(res: ApiOk<T> | ApiErr): res is ApiOk<T> {
  return res.ok === true;
}

export type OrderFillIndexData = {
  token_id: string;
  by_order_id: Record<string, { shares: number; avg_price_01: number; side: string; updated_at_ms: number }>;
};

/**
 * Align local trade history with the same CLOB `/data` trades feed Polymarket uses (order id → VWAP fill).
 * Safe to call often; skips rows that already match within a small epsilon.
 */
export async function reconcileTradeHistoryFromClob(tokenId: string): Promise<number> {
  const tid = tokenId.trim();
  if (!tid) return 0;

  const res = await tradeOrderFillIndex({ tokenId: tid });
  if (!isOk(res)) return 0;

  const { by_order_id: idx } = res.data as OrderFillIndexData;
  if (!idx || typeof idx !== 'object') return 0;

  const rows = loadTradeHistory();
  const EPS = 1e-4;
  let changed = false;
  let updates = 0;
  const next: TradeHistoryRow[] = rows.map((row) => {
    if (row.mode !== 'live' || row.token.trim() !== tid) return row;
    if (row.status !== 'filled' && row.status !== 'partial') return row;
    const oid = row.orderId?.trim();
    if (!oid) return row;
    const hit = idx[oid];
    if (!hit) return row;
    if (String(hit.side).toLowerCase() !== row.side) return row;

    const sh = roundShares4(Number(hit.shares));
    const px = roundPrice01(Number(hit.avg_price_01));
    if (!Number.isFinite(sh) || sh <= 0 || !Number.isFinite(px) || px <= 0 || px >= 1) return row;

    const usd = Math.abs(Math.round(px * sh * 100));
    if (
      row.shares != null &&
      Math.abs(row.shares - sh) < EPS &&
      row.fillAvgPrice01 != null &&
      Math.abs(row.fillAvgPrice01 - px) < EPS
    ) {
      return row;
    }

    changed = true;
    updates += 1;
    return {
      ...row,
      shares: sh,
      fillAvgPrice01: px,
      price01: px,
      usdCents: usd,
      auditNote: 'clob_trade_match',
    };
  });

  if (changed) saveTradeHistory(next);
  return updates;
}
