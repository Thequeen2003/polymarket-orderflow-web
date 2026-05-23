/**
 * Live trade UI must not invent fills — only CLOB/Bullpen trade tape or terminal getOrder.
 */

import { tradeOrderFillIndex, type ApiErr, type ApiOk } from './lib/api';
import { reconcileTradeHistoryFromClob } from './reconcileTradeHistoryFromClob';
import type { TradeExecutionMeta } from './tradeExecutionMeta';
import { extractOrderIdFromClobPayload } from './tradeExecutionMeta';
import { loadTradeHistory, type TradeHistoryRow } from './tradeHistory';
import { fillPrice01FromRow, normalizePrice01 } from './tradeFillPrice';
import { roundPrice01, roundShares4 } from './tradingRound';

function isOk<T>(res: ApiOk<T> | ApiErr): res is ApiOk<T> {
  return res.ok === true;
}

export function isVerifiedExchangeFill(execution?: TradeExecutionMeta): boolean {
  const f = execution?.fill;
  if (!f || f.status === 'unknown') return false;
  const sh = f.filled_shares;
  const px = f.avg_fill_price_01;
  return (
    sh != null &&
    px != null &&
    Number.isFinite(sh) &&
    sh > 0 &&
    Number.isFinite(px) &&
    px > 0 &&
    px < 1
  );
}

export type VerifiedLiveFill = {
  shares: number;
  avg01: number;
  rowStatus: 'filled' | 'partial';
  orderId: string | null;
};

/**
 * @deprecated Do not promote live UI to `filled` from HTTP `execution.fill` alone — use {@link confirmLiveFillOnTape}.
 */
export function verifiedFillFromExecution(
  execution: TradeExecutionMeta | undefined,
  parsed: unknown,
): VerifiedLiveFill | null {
  if (!isVerifiedExchangeFill(execution)) return null;
  const f = execution!.fill!;
  return {
    shares: roundShares4(f.filled_shares!),
    avg01: roundPrice01(f.avg_fill_price_01!),
    rowStatus: f.status === 'partial' ? 'partial' : 'filled',
    orderId: execution?.order_id ?? extractOrderIdFromClobPayload(parsed),
  };
}

/** Same trade tape Polymarket uses — required before showing live FILLED to the operator. */
export async function confirmLiveFillOnTape(
  tokenId: string,
  orderId: string | null | undefined,
): Promise<{ shares: number; avg01: number } | null> {
  const tid = tokenId.trim();
  const oid = orderId?.trim();
  if (!tid || !oid) return null;
  const res = await tradeOrderFillIndex({ tokenId: tid, force: true });
  if (!isOk(res)) return null;
  const hit = res.data.by_order_id[oid];
  if (!hit) return null;
  const sh = roundShares4(Number(hit.shares));
  const px = normalizePrice01(hit.avg_price_01);
  if (px == null || !Number.isFinite(sh) || sh <= 0 || !Number.isFinite(px) || px <= 0 || px >= 1) return null;
  return { shares: sh, avg01: px };
}

export function rowShowsExchangeFill(row: TradeHistoryRow | undefined): row is TradeHistoryRow & {
  status: 'filled' | 'partial';
  fillAvgPrice01: number;
  shares: number;
} {
  if (!row) return false;
  if (row.status !== 'filled' && row.status !== 'partial') return false;
  const px = row.fillAvgPrice01;
  const sh = row.shares;
  return px != null && px > 0 && px < 1 && sh != null && sh > 0;
}

export function rowTapeConfirmed(row: TradeHistoryRow | undefined): boolean {
  const a = String(row?.auditNote ?? '').toLowerCase();
  return a.includes('clob_tape') || a.includes('clob_trade_match');
}

/** Build a row patch when `getOrder` reports matched size (tape may lag). */
export function patchFromGetOrderMatch(input: {
  matched: number;
  orig: number;
  avg01: number | null;
  limit01: number | null;
  isTerminal: boolean;
  prevAudit?: string;
}): {
  status: 'filled' | 'partial';
  fillAvgPrice01: number;
  shares: number;
  remainingShares: number;
  price01: number;
  usdCents: number;
  auditNote: string;
} | null {
  const matched = roundShares4(input.matched);
  if (!(matched > 1e-6)) return null;
  const px =
    input.avg01 != null && input.avg01 > 0 && input.avg01 < 1
      ? roundPrice01(input.avg01)
      : input.limit01 != null && input.limit01 > 0 && input.limit01 < 1
        ? roundPrice01(input.limit01)
        : null;
  if (px == null) return null;
  const orig = input.orig > 0 ? input.orig : matched;
  const full = matched >= orig - 1e-4 || (input.isTerminal && matched > 0);
  const remaining = full ? 0 : Math.max(0, roundShares4(orig - matched));
  const tag = input.avg01 != null ? 'getorder_matched' : 'getorder_matched_limit_est';
  const prev = (input.prevAudit ?? '').trim();
  const auditNote = prev.includes(tag) ? prev : prev ? `${prev} · ${tag}` : tag;
  return {
    status: full ? 'filled' : 'partial',
    fillAvgPrice01: px,
    shares: matched,
    remainingShares: remaining,
    price01: px,
    usdCents: Math.abs(Math.round(px * matched * 100)),
    auditNote,
  };
}

export type TapeConfirmedFill = {
  shares: number;
  avg01: number;
  status: 'filled' | 'partial';
};

/**
 * Promote a live order row from the CLOB trade tape (same feed Polymarket uses).
 * Call after `getOrder` suggests match — never trust poll avg alone for `filled`.
 */
export async function reconcileLiveOrderFromTape(
  tokenId: string,
  orderId: string,
): Promise<TapeConfirmedFill | null> {
  const tid = tokenId.trim();
  const oid = orderId.trim();
  if (!tid || !oid) return null;

  try {
    await reconcileTradeHistoryFromClob(tid, { force: true });
  } catch {
    /* ignore */
  }

  const row = loadTradeHistory().find((r) => r.mode === 'live' && r.token.trim() === tid && r.orderId?.trim() === oid);
  if (rowShowsExchangeFill(row)) {
    const px = fillPrice01FromRow(row)!;
    return {
      shares: roundShares4(row.shares),
      avg01: px,
      status: row.status === 'partial' ? 'partial' : 'filled',
    };
  }

  const tape = await confirmLiveFillOnTape(tid, oid);
  if (!tape) return null;

  const req = row?.requestedShares;
  const partial = req != null && req > 0 && tape.shares + 1e-4 < req;
  return {
    shares: tape.shares,
    avg01: tape.avg01,
    status: partial ? 'partial' : 'filled',
  };
}
