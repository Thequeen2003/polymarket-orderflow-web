import {
  buildUpdownCanonicalTryTs,
  shouldSkipFutureUpdownBucketStart,
  updownShortcutAnchorFloors,
} from './updownBucketEt.js';
import { clobHasOrderbook, gammaMarketBySlugOrId, parseClobTokenIds } from './polymarket/index.js';

const GAMMA_CACHE_MS = 45_000;
const CLOB_CACHE_MS = 20_000;
const gammaCache = new Map<string, { at: number; market: Record<string, unknown> | null }>();
const clobCache = new Map<string, { at: number; has: boolean }>();

export async function gammaMarketCached(slug: string): Promise<Record<string, unknown> | null> {
  const key = slug.trim().toLowerCase();
  const hit = gammaCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < GAMMA_CACHE_MS) return hit.market;
  try {
    const m = (await gammaMarketBySlugOrId(key)) as Record<string, unknown>;
    gammaCache.set(key, { at: now, market: m });
    return m;
  } catch {
    gammaCache.set(key, { at: now, market: null });
    return null;
  }
}

export async function clobHasBookCached(tokenId: string): Promise<boolean> {
  const key = tokenId.trim();
  if (!key) return false;
  const hit = clobCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CLOB_CACHE_MS) return hit.has;
  const has = await clobHasOrderbook(key);
  clobCache.set(key, { at: now, has });
  return has;
}

export type CanonicalUpdownHit = {
  slug: string;
  ts: number;
  market: Record<string, unknown>;
  tested: boolean;
};

function marketLooksTradable(m: Record<string, unknown>, interval: '5m' | '15m' | '1h' | '4h' | '1d'): boolean {
  if (interval !== '5m' && interval !== '15m') return true;
  return m.active === true && m.closed !== true;
}

async function probeCanonicalSlug(args: {
  asset: string;
  interval: '5m' | '15m' | '1h' | '4h' | '1d';
  ts: number;
  stepSec: number;
  nowSec: number;
}): Promise<CanonicalUpdownHit | null> {
  const { asset, interval, ts, stepSec, nowSec } = args;
  if (shouldSkipFutureUpdownBucketStart(interval, ts, nowSec)) return null;
  const slug = `${asset}-updown-${interval}-${ts}`;
  const m = await gammaMarketCached(slug);
  if (!m) return null;
  const tokenIds = parseClobTokenIds(m.clobTokenIds ?? m.clob_token_ids);
  const t0 = tokenIds[0];
  if (!t0) return null;
  if (marketLooksTradable(m, interval)) {
    return { slug, ts, market: m, tested: false };
  }
  if (await clobHasBookCached(t0)) {
    return { slug, ts, market: m, tested: true };
  }
  return null;
}

/** Resolve `asset-updown-<interval>-<ts>` with a small parallel probe set (fast 5m/15m taps). */
export async function resolveCanonicalUpdownSlug(args: {
  asset: string;
  interval: '5m' | '15m' | '1h' | '4h' | '1d';
  stepSec: number;
  nowSec: number;
  floorSec: number;
}): Promise<CanonicalUpdownHit | null> {
  const { asset, interval, stepSec, nowSec, floorSec } = args;
  const { et: etAnchor } = updownShortcutAnchorFloors(stepSec, nowSec);
  const tryTs = buildUpdownCanonicalTryTs({
    stepSec,
    nowSec,
    floorSec,
    etAnchor,
    interval,
  });
  const batchSize = interval === '5m' || interval === '15m' ? 4 : 3;
  for (let i = 0; i < tryTs.length; i += batchSize) {
    const batch = tryTs.slice(i, i + batchSize);
    const hits = await Promise.all(
      batch.map((ts) => probeCanonicalSlug({ asset, interval, ts, stepSec, nowSec })),
    );
    const found = hits.find((h) => h != null);
    if (found) return found;
  }
  return null;
}
