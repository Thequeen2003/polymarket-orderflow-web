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
  return source === 'rtds_chainlink_window_open' || source === 'rtds_chainlink_pre_open_tick';
}
