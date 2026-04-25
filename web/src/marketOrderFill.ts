/** Best-effort parse of Polymarket / CLOB market-order API payloads (shapes vary by SDK version). */

import { roundPrice01, roundShares4 } from './tradingRound';

/** Outcome share counts from the API stay in a sane range; avoid mistaking micro-USDC for shares. */
function plausibleOutcomeShares(n: number): boolean {
  return Number.isFinite(n) && n > 0 && n < 1e7;
}

function pickNum(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const p = parseFloat(v);
      if (Number.isFinite(p)) return p;
    }
  }
  return null;
}

function toPrice01(raw: number): number | null {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  if (raw <= 1) return raw;
  if (raw <= 100) return raw / 100;
  return null;
}

function collectContainers(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== 'object') return [];
  const root = data as Record<string, unknown>;
  const seen = new Set<object>();
  const out: Record<string, unknown>[] = [];
  const push = (x: Record<string, unknown>) => {
    const r = x as object;
    if (seen.has(r)) return;
    seen.add(r);
    out.push(x);
  };
  for (const key of ['order', 'data', 'result', 'response'] as const) {
    const inner = root[key];
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) continue;
    push(inner as Record<string, unknown>);
    const sub = inner as Record<string, unknown>;
    const innerOrder = sub.order ?? sub.result;
    if (innerOrder && typeof innerOrder === 'object' && !Array.isArray(innerOrder)) {
      push(innerOrder as Record<string, unknown>);
    }
  }
  push(root);
  return out;
}

function firstNum(containers: Record<string, unknown>[], keys: string[]): number | null {
  for (const c of containers) {
    const n = pickNum(c, keys);
    if (n != null) return n;
  }
  return null;
}

/** Volume-weighted average from nested maker fills when the CLOB returns them. */
function weightedAvgFromMakerOrders(containers: Record<string, unknown>[]): { price01: number; shares: number } | null {
  for (const c of containers) {
    const mos = c.maker_orders ?? c.makerOrders;
    if (!Array.isArray(mos) || mos.length === 0) continue;
    let sumPxSz = 0;
    let sumSz = 0;
    for (const mo of mos) {
      if (!mo || typeof mo !== 'object') continue;
      const o = mo as Record<string, unknown>;
      const pRaw = pickNum(o, ['price', 'matched_price', 'avg_price', 'avgPrice']);
      const sRaw = pickNum(o, ['matched_amount', 'size', 'amount', 'quantity', 'shares']);
      if (pRaw == null || sRaw == null || !plausibleOutcomeShares(sRaw)) continue;
      const p01 = toPrice01(pRaw);
      if (p01 == null) continue;
      sumPxSz += p01 * sRaw;
      sumSz += sRaw;
    }
    if (sumSz > 0) return { price01: roundPrice01(sumPxSz / sumSz), shares: roundShares4(sumSz) };
  }
  return null;
}

export type BestEffortSellCtx = { kind: 'sell'; requestedShares: number; mid01: number | null };
export type BestEffortBuyCtx = {
  kind: 'buy';
  amountUsd: number;
  mid01: number | null;
  requestedShares: number | null;
};

export function bestEffortMarketFill(
  data: unknown,
  ctx: BestEffortSellCtx | BestEffortBuyCtx,
): { price01: number | null; shares: number | null; usdCents: number | null } {
  const containers = collectContainers(data);
  const w = weightedAvgFromMakerOrders(containers);
  const avgRaw = firstNum(containers, [
    'avg_price',
    'average_price',
    'avgPrice',
    'avg_fill_price',
    'avgFillPrice',
    'averagePrice',
    'price',
  ]);
  let price01: number | null = w != null ? w.price01 : avgRaw != null ? toPrice01(avgRaw) : null;

  // Do not use takingAmount/makingAmount here — Polymarket often returns those in 6dp base units (USDC vs shares).
  const sizeRaw = firstNum(containers, [
    'size_matched',
    'sizeMatched',
    'filledSize',
    'filled_size',
    'filled_shares',
    'matched_size',
    'size',
  ]);

  if (ctx.kind === 'sell') {
    let shares =
      w?.shares != null
        ? w.shares
        : sizeRaw != null && plausibleOutcomeShares(sizeRaw) && ctx.requestedShares > 0
          ? // Guard: some payloads report notional-ish sizes; only trust if near requested shares.
            Math.abs(sizeRaw - ctx.requestedShares) <= Math.max(0.02, ctx.requestedShares * 0.15)
            ? sizeRaw
            : null
          : ctx.requestedShares > 0
            ? ctx.requestedShares
            : null;
    if (shares != null) {
      shares = roundShares4(shares);
      if (shares <= 0) shares = null;
    }
    if (price01 == null && ctx.mid01 != null && ctx.mid01 > 0) price01 = ctx.mid01;
    if (price01 != null) price01 = roundPrice01(price01);
    const usdCents =
      price01 != null && shares != null && Number.isFinite(shares) && shares > 0
        ? Math.round(Math.abs(price01 * shares * 100))
        : null;
    return { price01, shares, usdCents };
  }

  const usdCents = Math.abs(Math.round(ctx.amountUsd * 100));
  let shares: number | null =
    w?.shares != null
      ? w.shares
      : ctx.requestedShares != null && Number.isFinite(ctx.requestedShares) && ctx.requestedShares > 0
        ? ctx.requestedShares
        : null;
  // Some SDK payloads reuse "filled_size" for USDC-like notional. Only trust sizeRaw if it matches expected shares.
  if ((shares == null || !Number.isFinite(shares)) && sizeRaw != null && plausibleOutcomeShares(sizeRaw)) {
    const expected = price01 != null && price01 > 0 ? ctx.amountUsd / price01 : null;
    if (expected != null && expected > 0) {
      const ratio = sizeRaw / expected;
      if (Number.isFinite(ratio) && ratio > 0.2 && ratio < 5) shares = sizeRaw;
    } else {
      // If we can't compute expected shares, fall back cautiously (avoid huge bogus numbers).
      if (sizeRaw < 50_000) shares = sizeRaw;
    }
  }

  if (price01 == null && shares != null && shares > 0 && ctx.amountUsd > 0) {
    price01 = ctx.amountUsd / shares;
    if (price01 > 1) price01 = null;
  }
  if (price01 == null && ctx.mid01 != null && ctx.mid01 > 0) price01 = ctx.mid01;
  if ((shares == null || !Number.isFinite(shares)) && price01 != null && price01 > 0) {
    shares = ctx.amountUsd / price01;
  }
  if ((!Number.isFinite(shares as number) || (shares as number) <= 0) && ctx.mid01 != null && ctx.mid01 > 0) {
    shares = ctx.amountUsd / ctx.mid01;
  }
  if (!Number.isFinite(shares as number) || (shares as number) <= 0) shares = null;
  if (shares != null) {
    shares = roundShares4(shares);
    if (shares <= 0) shares = null;
  }
  if (price01 != null) price01 = roundPrice01(price01);

  return { price01, shares, usdCents };
}
