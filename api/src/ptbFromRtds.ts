export type RtdsHistSource = 'chainlink' | 'binance';

export type RtdsHistPoint = { t: number; v: number; src?: RtdsHistSource };

export type DerivePtbOptions = {
  /** When false, return null if no tick at/after open (pre-open windows). Default true for live buckets. */
  allowPreOpenFallback?: boolean;
  /** For Polymarket slash-USD markets, ignore Binance ticks entirely. Default true. */
  chainlinkOnly?: boolean;
  /** Max ms after window open for the first tick to count as the open print. Default 15s. */
  openTickGraceMs?: number;
};

/** Chainlink USD prints carry more precision than Binance USDT mirrors. */
export function looksLikeChainlinkUsd(v: number): boolean {
  if (!Number.isFinite(v)) return false;
  const frac = String(v).split('.')[1] ?? '';
  return frac.replace(/0+$/, '').length >= 3;
}

function pickPreferredTick(a: RtdsHistPoint, b: RtdsHistPoint): RtdsHistPoint {
  if (a.src === 'chainlink' && b.src !== 'chainlink') return a;
  if (b.src === 'chainlink' && a.src !== 'chainlink') return b;
  if (a.src === 'binance' && b.src !== 'binance') return b;
  if (b.src === 'binance' && a.src !== 'binance') return a;
  const aCl = looksLikeChainlinkUsd(a.v);
  const bCl = looksLikeChainlinkUsd(b.v);
  if (aCl && !bCl) return a;
  if (bCl && !aCl) return b;
  return b;
}

/** Collapse duplicate timestamps; prefer Chainlink over Binance at the same millisecond. */
export function dedupeRtdsHistPreferChainlink(hist: RtdsHistPoint[]): RtdsHistPoint[] {
  if (hist.length <= 1) return hist.slice();
  const byT = new Map<number, RtdsHistPoint>();
  for (const p of hist) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.v)) continue;
    const prev = byT.get(p.t);
    byT.set(p.t, prev ? pickPreferredTick(prev, p) : p);
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

export function chainlinkUsdHistory(hist: RtdsHistPoint[]): RtdsHistPoint[] {
  return dedupeRtdsHistPreferChainlink(hist).filter(
    (p) => p.src === 'chainlink' || (p.src !== 'binance' && looksLikeChainlinkUsd(p.v)),
  );
}

/** Chainlink open print often lands late on RTDS; widen grace as the window ages. */
export function openTickGraceMsForBucket(bucketAgeMs: number): number {
  if (bucketAgeMs < 45_000) return 15_000;
  if (bucketAgeMs < 120_000) return 90_000;
  return 300_000;
}

/** True when history includes a tick within grace of window open, or a before-open tick. */
export function historyCoversBucketOpen(
  hist: RtdsHistPoint[],
  bucketStartMs: number,
  openTickGraceMs = 15_000,
): boolean {
  const clean = dedupeRtdsHistPreferChainlink(hist);
  if (clean.length === 0) return false;
  if (clean.some((p) => p.t >= bucketStartMs && p.t <= bucketStartMs + openTickGraceMs)) return true;
  return clean.some((p) => p.t <= bucketStartMs);
}

/**
 * Polymarket crypto up/down PTB = Chainlink oracle price at the window open.
 * Use the first Chainlink tick at or on/after `bucketStartMs` within `openTickGraceMs`;
 * when the bucket is live but the open tick has not printed yet, fall back to the last tick before the open.
 */
export function derivePtbFromRtdsHistory(
  hist: RtdsHistPoint[],
  bucketStartMs: number,
  opts?: DerivePtbOptions,
): number | null {
  const allowPreOpenFallback = opts?.allowPreOpenFallback !== false;
  const chainlinkOnly = opts?.chainlinkOnly !== false;
  const openTickGraceMs = opts?.openTickGraceMs ?? 15_000;
  let clean = chainlinkOnly ? chainlinkUsdHistory(hist) : dedupeRtdsHistPreferChainlink(hist);
  if (clean.length === 0) return null;

  for (let i = 0; i < clean.length; i++) {
    const p = clean[i]!;
    if (p.t >= bucketStartMs) {
      if (p.t > bucketStartMs + openTickGraceMs) break;
      const v = Number(p.v);
      return Number.isFinite(v) ? v : null;
    }
  }

  if (!allowPreOpenFallback) return null;

  let before: RtdsHistPoint | null = null;
  for (let i = 0; i < clean.length; i++) {
    const p = clean[i]!;
    if (p.t <= bucketStartMs) before = p;
    else break;
  }
  if (!before) return null;
  const v = Number(before.v);
  return Number.isFinite(v) ? v : null;
}

/**
 * When the ring buffer no longer includes the open print (4h / 1d desks after restart),
 * use the Chainlink tick closest to window open within `maxAfterOpenMs` (default 5m).
 */
export function derivePtbNearestOpenTick(
  hist: RtdsHistPoint[],
  bucketStartMs: number,
  maxAfterOpenMs = 300_000,
): number | null {
  const clean = chainlinkUsdHistory(hist);
  if (clean.length === 0) return null;
  let best: RtdsHistPoint | null = null;
  let bestDist = Infinity;
  for (const p of clean) {
    if (p.t < bucketStartMs) continue;
    const dist = p.t - bucketStartMs;
    if (dist > maxAfterOpenMs) break;
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  if (!best) return null;
  const v = Number(best.v);
  return Number.isFinite(v) ? v : null;
}

/** Strict open print, then nearest tick within grace when the bucket is already live. */
export function derivePtbFromRtdsHistoryBestEffort(
  hist: RtdsHistPoint[],
  bucketStartMs: number,
  bucketAgeMs: number,
  opts?: DerivePtbOptions,
): number | null {
  const openTickGraceMs = opts?.openTickGraceMs ?? openTickGraceMsForBucket(bucketAgeMs);
  const strict = derivePtbFromRtdsHistory(hist, bucketStartMs, {
    ...opts,
    openTickGraceMs,
  });
  if (strict != null) return strict;
  if (bucketAgeMs < 45_000) return null;
  const nearest = derivePtbNearestOpenTick(hist, bucketStartMs, Math.max(openTickGraceMs, 300_000));
  return nearest;
}

export function bucketPtbCacheKey(symbol: string, bucketStartMs: number): string {
  return `${symbol.trim().toLowerCase()}|${bucketStartMs}`;
}

/** Pre-open desk readout: last Chainlink tick before window open, else live spot. */
export function derivePtbPreview(
  hist: RtdsHistPoint[],
  bucketStartMs: number,
  liveSpotUsd: number | null | undefined,
): number | null {
  const clean = chainlinkUsdHistory(hist);
  let before: RtdsHistPoint | null = null;
  for (const p of clean) {
    if (p.t < bucketStartMs) before = p;
    else break;
  }
  if (before) {
    const v = Number(before.v);
    if (Number.isFinite(v)) return v;
  }
  if (liveSpotUsd != null && Number.isFinite(liveSpotUsd)) return liveSpotUsd;
  return null;
}

export function isLockedPtbSource(source: string): boolean {
  return (
    source === 'rtds_chainlink_window_open' ||
    source === 'rtds_chainlink_pre_open_tick' ||
    source === 'polymarket_page_price_to_beat' ||
    source === 'polymarket_page_open_price'
  );
}
