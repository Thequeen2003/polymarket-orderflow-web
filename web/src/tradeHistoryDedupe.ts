/**
 * Dedupe live fill rows — one row per CLOB order id (avoids local + tape double entries).
 */

import type { MyFillRow } from './lib/api';
import { rowShowsExchangeFill } from './liveTradeTruth';
import { fillPrice01FromRow } from './tradeFillPrice';
import {
  loadTradeHistory,
  saveTradeHistory,
  TRADE_HISTORY_MAX_ROWS,
  type TradeHistoryRow,
} from './tradeHistory';
import { aggregateMyFillsByOrderId } from './syncTradeHistoryFromMyFills';
import { roundPrice01, roundShares4 } from './tradingRound';

const SHARE_EPS = 1e-4;
const PRICE_EPS = 0.02;
const TIME_EPS_MS = 120_000;

function auditIsBracketAuto(audit: string | undefined): boolean {
  const a = String(audit ?? '').toLowerCase();
  return a.includes('stop_loss') || a.includes('take_profit');
}

/** Upgrade bracket SL/TP rows from aggregated tape when still resting/partial locally. */
function upgradeBracketRowsFromTape(rows: TradeHistoryRow[], myFills: MyFillRow[], tokenId: string): TradeHistoryRow[] {
  const agg = aggregateMyFillsByOrderId(myFills, tokenId);
  if (agg.size === 0) return rows;
  return rows.map((r) => {
    const oid = String(r.orderId ?? '').trim();
    if (!oid || !auditIsBracketAuto(r.auditNote)) return r;
    const a = agg.get(oid);
    if (!a || !(a.sumSh > SHARE_EPS)) return r;
    const px = roundPrice01(a.sumPxSh / Math.max(a.sumSh, 1e-12));
    const sh = roundShares4(a.sumSh);
    const tgt = r.requestedShares ?? r.shares;
    const wantFull = tgt == null || !Number.isFinite(tgt) || tgt <= 0 || sh + SHARE_EPS >= tgt;
    const nextStatus = wantFull ? ('filled' as const) : ('partial' as const);
    if (r.status === 'filled' && r.fillAvgPrice01 != null && Math.abs((r.shares ?? 0) - sh) < 1e-3) return r;
    if (r.status === 'partial' && !wantFull && r.shares != null && Math.abs(r.shares - sh) < 1e-3) return r;
    if (
      r.status === 'sent' ||
      r.status === 'sending' ||
      r.status === 'pending' ||
      r.status === 'submitted' ||
      r.status === 'partial'
    ) {
      return {
        ...r,
        status: nextStatus,
        fillAvgPrice01: px,
        price01: px,
        shares: sh,
        remainingShares: wantFull ? 0 : Math.max(0, (typeof tgt === 'number' ? tgt : sh) - sh),
        usdCents: Math.abs(Math.round(px * sh * 100)),
        ts: Math.max(r.ts ?? 0, a.lastMs),
      };
    }
    return r;
  });
}

export function fillRowQualityScore(row: TradeHistoryRow): number {
  let s = 0;
  if (row.orderId?.trim()) s += 16;
  if (rowShowsExchangeFill(row)) s += 8;
  if (row.submittedPrice01 != null) s += 4;
  if (row.fillAvgPrice01 != null) s += 2;
  if (row.requestedShares != null) s += 1;
  const audit = String(row.auditNote ?? '').toLowerCase();
  if (audit.includes('clob_tape') || audit.includes('my_fills_sync') || audit.includes('clob_trade_match')) {
    s += 2;
  }
  return s;
}

function isFilledLike(row: TradeHistoryRow): boolean {
  return row.status === 'filled' || row.status === 'partial';
}

/** Prefer the richest row per order id; drop orphan duplicates without oid that match a kept row. */
export function dedupeFilledRowsByOrderId(rows: TradeHistoryRow[]): TradeHistoryRow[] {
  const byOid = new Map<string, TradeHistoryRow>();
  const orphans: TradeHistoryRow[] = [];

  for (const r of rows) {
    const oid = r.orderId?.trim();
    if (oid) {
      const prev = byOid.get(oid);
      if (!prev || fillRowQualityScore(r) > fillRowQualityScore(prev)) {
        byOid.set(oid, r);
      }
      continue;
    }
    orphans.push(r);
  }

  const kept = [...byOid.values()];
  for (const o of orphans) {
    const oPx = fillPrice01FromRow(o);
    const oSh = o.shares;
    const dup = kept.some((k) => {
      if (k.side !== o.side) return false;
      const kPx = fillPrice01FromRow(k);
      const kSh = k.shares;
      if (oSh == null || kSh == null || oPx == null || kPx == null) return false;
      if (Math.abs(oSh - kSh) > SHARE_EPS) return false;
      if (Math.abs(oPx - kPx) > PRICE_EPS) return false;
      return Math.abs((k.ts ?? 0) - (o.ts ?? 0)) <= TIME_EPS_MS;
    });
    if (!dup) kept.push(o);
  }

  return kept.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
}

/** Build recent-fills list: local history first, tape-only orders when no local row exists. */
export function mergeRecentFillsForDisplay(args: {
  localFilled: TradeHistoryRow[];
  myFills: MyFillRow[];
  tokenId: string;
  mode: 'live' | 'paper';
  limit?: number;
}): TradeHistoryRow[] {
  const limit = args.limit ?? 12;
  const localCandidates =
    args.mode === 'live' && args.myFills.length
      ? upgradeBracketRowsFromTape(args.localFilled, args.myFills, args.tokenId)
      : args.localFilled;
  const upgraded = localCandidates.filter((r) => isFilledLike(r) && (args.mode !== 'live' || rowShowsExchangeFill(r)));
  const local = dedupeFilledRowsByOrderId(upgraded);

  if (args.mode !== 'live' || !args.myFills.length) {
    return local.slice(0, limit);
  }

  const localOids = new Set(
    local.map((r) => r.orderId?.trim()).filter((oid): oid is string => Boolean(oid)),
  );
  const agg = aggregateMyFillsByOrderId(args.myFills, args.tokenId);
  const supplemental: TradeHistoryRow[] = [];

  for (const [oid, a] of agg) {
    if (localOids.has(oid) || !(a.sumSh > SHARE_EPS)) continue;
    const sh = roundShares4(a.sumSh);
    const px = roundPrice01(a.sumPxSh / Math.max(a.sumSh, 1e-12));
    if (!Number.isFinite(sh) || sh <= 0 || !Number.isFinite(px) || px <= 0 || px >= 1) continue;
    supplemental.push({
      id: `tape-${oid}-${a.lastMs}`,
      ts: a.lastMs,
      mode: 'live',
      exec: 'limit',
      side: a.side,
      token: args.tokenId.trim(),
      label: '',
      price01: px,
      fillAvgPrice01: px,
      submittedPrice01: px,
      shares: sh,
      requestedShares: sh,
      remainingShares: 0,
      usdCents: Math.abs(Math.round(px * sh * 100)),
      status: 'filled',
      orderId: oid,
      auditNote: 'clob_tape_display',
    });
  }

  return [...local, ...supplemental].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, limit);
}

/**
 * Remove inferior duplicate filled/partial live rows for one token (same order id).
 * Returns number of rows removed from storage.
 */
export function pruneDuplicateLiveFillsInHistory(tokenId: string): number {
  const tid = tokenId.trim();
  if (!tid) return 0;

  const rows = loadTradeHistory();
  const dropIds = new Set<string>();

  const groups = new Map<string, TradeHistoryRow[]>();
  for (const r of rows) {
    if (r.mode !== 'live' || r.token.trim() !== tid || !isFilledLike(r)) continue;
    const oid = r.orderId?.trim();
    if (!oid) continue;
    const g = groups.get(oid) ?? [];
    g.push(r);
    groups.set(oid, g);
  }

  for (const [, g] of groups) {
    if (g.length <= 1) continue;
    g.sort((a, b) => fillRowQualityScore(b) - fillRowQualityScore(a));
    for (let i = 1; i < g.length; i++) dropIds.add(g[i]!.id);
  }

  if (dropIds.size === 0) return 0;

  const next = rows.filter((r) => !dropIds.has(r.id));
  saveTradeHistory(next.slice(0, TRADE_HISTORY_MAX_ROWS));
  return dropIds.size;
}
