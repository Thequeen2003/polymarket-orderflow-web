/**
 * Display helpers for trade history rows — `shares` on `sent` rows is often the
 * requested size (legacy optimistic rows), not filled size.
 */

import type { TradeHistoryRow } from './tradeHistory';
import { rowShowsExchangeFill } from './liveTradeTruth';
import { floorShares4, roundShares4 } from './tradingRound';

export function requestedSharesFromRow(
  row: Pick<TradeHistoryRow, 'requestedShares' | 'shares' | 'status'>,
): number | null {
  if (row.requestedShares != null && row.requestedShares > 0) return row.requestedShares;
  if (
    (row.status === 'sent' || row.status === 'sending' || row.status === 'pending') &&
    row.shares != null &&
    row.shares > 0
  ) {
    return row.shares;
  }
  return row.shares != null && row.shares > 0 ? row.shares : null;
}

/** Filled shares for UI — exchange-confirmed, or derived from size − remaining on open orders. */
export function filledSharesFromRow(
  row: Pick<TradeHistoryRow, 'status' | 'shares' | 'requestedShares' | 'remainingShares' | 'fillAvgPrice01'>,
): number {
  if (rowShowsExchangeFill(row as TradeHistoryRow)) return roundShares4(row.shares ?? 0);
  const req = requestedSharesFromRow(row);
  const rem = row.remainingShares;
  if (req != null && rem != null && Number.isFinite(req) && Number.isFinite(rem)) {
    return floorShares4(Math.max(0, req - rem));
  }
  if (row.status === 'sent' || row.status === 'sending' || row.status === 'pending' || row.status === 'submitted') {
    return 0;
  }
  if (row.status === 'partial' && row.fillAvgPrice01 != null && row.shares != null) {
    return roundShares4(row.shares);
  }
  return 0;
}

export function remainingSharesFromRow(
  row: Pick<TradeHistoryRow, 'status' | 'shares' | 'requestedShares' | 'remainingShares' | 'fillAvgPrice01'>,
): number | null {
  if (row.remainingShares != null && Number.isFinite(row.remainingShares)) {
    return roundShares4(Math.max(0, row.remainingShares));
  }
  const req = requestedSharesFromRow(row);
  if (req == null) return null;
  return floorShares4(Math.max(0, req - filledSharesFromRow(row)));
}

export function isRestingLiveOrderRow(row: Pick<TradeHistoryRow, 'status' | 'mode'>): boolean {
  if (row.mode !== 'live') return false;
  return row.status === 'sent' || row.status === 'sending' || row.status === 'pending' || row.status === 'submitted';
}

/** Net matched shares from local history when wallet balance lags after a fill. */
export function netMatchedSharesFromHistory(rows: TradeHistoryRow[], tokenId: string): number {
  const tid = tokenId.trim();
  if (!tid) return 0;
  let net = 0;
  for (const r of rows) {
    if (r.mode !== 'live' || r.token.trim() !== tid) continue;
    const sh = filledSharesFromRow(r);
    if (!(sh > 1e-6)) continue;
    if (r.side === 'buy') net += sh;
    else if (r.side === 'sell') net -= sh;
  }
  return floorShares4(Math.max(0, net));
}
