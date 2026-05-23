/**
 * Canonical fill extraction from Polymarket CLOB / Bullpen market-order JSON.
 * No book mid or client guesses — only payload fields and maker-order VWAP.
 */

import { CONDITIONAL_TOKEN_DECIMALS } from '@polymarket/clob-client-v2';

export type CanonicalFillStatus = 'filled' | 'partial' | 'unknown';

export type CanonicalFillEnvelope = {
  filled_shares: number | null;
  avg_fill_price_01: number | null;
  status: CanonicalFillStatus;
};

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

function roundShares4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function roundPrice01(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function plausibleOutcomeShares(n: number): boolean {
  return Number.isFinite(n) && n > 0 && n < 1e7;
}

/**
 * Prefer nested order-shaped objects over the response root. The root often carries
 * limit/cross metadata and stale `size` fields; real fills live on `order` / `data.order`.
 */
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

function firstStr(containers: Record<string, unknown>[], keys: string[]): string | null {
  for (const c of containers) {
    for (const k of keys) {
      const v = c[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

/** Open/resting orders must not be reported as market fills (avoids size/price mistaken for fill). */
function statusBlocksFillClaim(statusUpper: string): boolean {
  if (!statusUpper) return false;
  if (statusUpper.includes('CANCEL')) return true;
  return (
    statusUpper === 'LIVE' ||
    statusUpper === 'OPEN' ||
    statusUpper === 'ACTIVE' ||
    statusUpper === 'UNFILLED' ||
    statusUpper === 'PENDING' ||
    statusUpper === 'RESTING' ||
    statusUpper === 'SUBMITTED' ||
    statusUpper === 'PLACED'
  );
}

function makerOrderAssetId(mo: Record<string, unknown>): string {
  return String(mo.asset_id ?? mo.assetId ?? mo.token_id ?? mo.tokenID ?? mo.asset ?? '').trim();
}

/** VWAP from nested maker fills when the CLOB returns them. */
function weightedAvgFromMakerOrders(
  containers: Record<string, unknown>[],
  tokenID?: string,
): { price01: number; shares: number } | null {
  const want = tokenID?.trim() || '';
  for (const c of containers) {
    const mos = c.maker_orders ?? c.makerOrders;
    if (!Array.isArray(mos) || mos.length === 0) continue;
    let anyMakerAsset = false;
    if (want) {
      for (const mo of mos) {
        if (!mo || typeof mo !== 'object') continue;
        if (makerOrderAssetId(mo as Record<string, unknown>)) {
          anyMakerAsset = true;
          break;
        }
      }
    }
    const filterByToken = Boolean(want && anyMakerAsset);
    let sumPxSz = 0;
    let sumSz = 0;
    for (const mo of mos) {
      if (!mo || typeof mo !== 'object') continue;
      const o = mo as Record<string, unknown>;
      if (filterByToken) {
        const aid = makerOrderAssetId(o);
        if (aid && aid !== want) continue;
      }
      const pRaw = pickNum(o, ['price', 'matched_price', 'avg_price', 'avgPrice']);
      const sRaw = pickNum(o, ['matched_amount', 'size', 'amount', 'quantity', 'shares']);
      if (pRaw == null || sRaw == null) continue;
      const sNorm = normalizeConditionalSizeRaw(sRaw);
      if (sNorm == null || !plausibleOutcomeShares(sNorm)) continue;
      const p01 = toPrice01(pRaw);
      if (p01 == null) continue;
      sumPxSz += p01 * sNorm;
      sumSz += sNorm;
    }
    if (sumSz > 0) return { price01: roundPrice01(sumPxSz / sumSz), shares: roundShares4(sumSz) };
  }
  return null;
}

const SIZE_KEYS = ['size_matched', 'sizeMatched', 'filled_shares', 'filled_size', 'filledSize', 'matched_size', 'matchedSize'] as const;
const STRICT_AVG_KEYS = [
  'avg_fill_price',
  'avgFillPrice',
  'avg_fill_price_01',
  'mean_execution_price',
  'meanExecutionPrice',
  'execution_price',
  'executionPrice',
] as const;
const LOOSE_AVG_KEYS = ['average_price', 'averagePrice', 'avg_price', 'avgPrice'] as const;

/**
 * When maker VWAP is unavailable, use `size_matched` + an average **from the same object only**
 * (avoids pairing root `average_price` with nested `size_matched`, etc.).
 * `average_price` here is allowed only as a co-located fallback after strict keys miss.
 */
function sameContainerMatchedFill(containers: Record<string, unknown>[]): { price01: number; shares: number } | null {
  for (const c of containers) {
    const sizeRaw = pickNum(c, [...SIZE_KEYS]);
    const filledFromTop =
      sizeRaw != null ? (normalizeConditionalSizeUnknown(sizeRaw) ?? (plausibleOutcomeShares(sizeRaw) ? sizeRaw : null)) : null;
    if (filledFromTop == null || !plausibleOutcomeShares(filledFromTop)) continue;
    const strict = pickNum(c, [...STRICT_AVG_KEYS]);
    const avg01 = strict != null ? toPrice01(strict) : null;
    const loose = avg01 == null ? pickNum(c, [...LOOSE_AVG_KEYS]) : null;
    const avg02 = loose != null ? toPrice01(loose) : null;
    const avg = avg01 ?? avg02;
    if (avg == null || avg <= 0 || avg >= 1) continue;
    return { price01: avg, shares: roundShares4(filledFromTop) };
  }
  return null;
}

function toHumanAmount(raw: number, decimals: number): string {
  const denom = 10 ** decimals;
  return String(raw / denom);
}

/** Normalize CLOB conditional size integers to human shares (same idea as server `normalizeAmountMaybe`). */
function normalizeConditionalSizeRaw(raw: number): number | null {
  if (!Number.isFinite(raw)) return null;
  const intOk = Number.isInteger(raw);
  if (!intOk) return raw;
  const decimals = CONDITIONAL_TOKEN_DECIMALS;
  const minRaw = 10 ** Math.max(0, decimals - 2);
  if (Math.abs(raw) < minRaw) return raw;
  const s = toHumanAmount(raw, decimals);
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeConditionalSizeUnknown(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return null;
  const str = typeof raw === 'string' ? raw.trim() : '';
  const intOk =
    (typeof raw === 'string' && /^-?\d+$/.test(str) && !/[eE]/.test(str)) ||
    (typeof raw === 'number' && Number.isInteger(n));
  if (!intOk) return n;
  return normalizeConditionalSizeRaw(n);
}

/**
 * Extract display-safe fill: both shares and VWAP must be derivable from the payload,
 * otherwise status `unknown` and nulls (client may poll `getOrder`).
 */
export function extractCanonicalMarketFill(
  parsed: unknown,
  ctx: { side: 'buy' | 'sell'; amount: number; tokenID?: string }, // `amount` is sell share request (FAK); buy uses payload fields only.
): CanonicalFillEnvelope {
  const containers = collectContainers(parsed);
  const w = weightedAvgFromMakerOrders(containers, ctx.tokenID);

  let filledShares: number | null = null;
  let avg01: number | null = null;

  if (w != null) {
    filledShares = w.shares;
    avg01 = w.price01;
  } else {
    const sc = sameContainerMatchedFill(containers);
    if (sc != null) {
      filledShares = sc.shares;
      avg01 = sc.price01;
    }
  }

  const statusUpper = String(firstStr(containers, ['status', 'order_status', 'state']) ?? '').toUpperCase();
  if (statusBlocksFillClaim(statusUpper)) {
    return { filled_shares: null, avg_fill_price_01: null, status: 'unknown' };
  }

  if (filledShares == null || filledShares <= 0 || avg01 == null || avg01 <= 0 || avg01 >= 1) {
    return { filled_shares: null, avg_fill_price_01: null, status: 'unknown' };
  }

  const originalShares = firstNum(containers, ['original_size', 'originalSize', 'original', 'total_size', 'size']);
  const origNorm =
    originalShares != null
      ? normalizeConditionalSizeUnknown(originalShares) ?? (plausibleOutcomeShares(originalShares) ? originalShares : null)
      : null;

  let status: CanonicalFillStatus = 'filled';
  if (ctx.side === 'sell' && ctx.amount > 0) {
    const req = roundShares4(ctx.amount);
    if (filledShares < req - 1e-3) status = 'partial';
  } else if (origNorm != null && plausibleOutcomeShares(origNorm) && filledShares < origNorm - 1e-3) {
    status = 'partial';
  }

  return {
    filled_shares: filledShares,
    avg_fill_price_01: avg01,
    status,
  };
}
