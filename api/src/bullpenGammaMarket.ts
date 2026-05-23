import { resolveBullpenOrderOutcome, type ResolveBullpenOrderOutcomeResult } from './bullpenOutcome.js';
import { gammaMarketBySlugOrId } from './polymarket/gamma.js';
import { normalizeMarket } from './polymarket/marketNormalize.js';

const cache = new Map<string, { market: Record<string, unknown>; at: number }>();
const TTL_MS = 60_000;

export async function gammaMarketForSlug(slug: string): Promise<Record<string, unknown> | null> {
  const key = slug.trim().toLowerCase();
  if (!key) return null;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.market;
  try {
    const raw = await gammaMarketBySlugOrId(key);
    if (!raw || typeof raw !== 'object') return null;
    const market = normalizeMarket(raw) as Record<string, unknown>;
    cache.set(key, { market, at: Date.now() });
    return market;
  } catch {
    return null;
  }
}

export function parseOrderLane(body: Record<string, unknown>): 'up' | 'down' | null {
  const raw = body.lane ?? body.outcome_lane;
  return raw === 'up' || raw === 'down' ? raw : null;
}

export async function resolveBullpenOutcomeForOrder(params: {
  token: string;
  marketSlug: string;
  outcome: string;
  lane: 'up' | 'down' | null;
}): Promise<ResolveBullpenOrderOutcomeResult> {
  const market = params.marketSlug.trim() ? await gammaMarketForSlug(params.marketSlug) : null;
  return resolveBullpenOrderOutcome({
    tokenId: params.token,
    marketSlug: params.marketSlug,
    lane: params.lane,
    outcomeHint: params.outcome,
    market,
  });
}
