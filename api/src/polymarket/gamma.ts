import { gammaApiUrl } from '../polymarketApiUrls.js';
import { polymarketGetJson } from './http.js';

const GAMMA = () => gammaApiUrl();

/** Gamma supports different sort keys over time; try "most active" first, then fall back. */
export async function gammaMarketsList(limit: number): Promise<unknown[]> {
  const base = `${GAMMA()}/markets?limit=${limit}&active=true&closed=false`;
  const tryUrls = [
    `${base}&archived=false&order=volume24hr&ascending=false`,
    `${base}&archived=false&order=volume&ascending=false`,
    `${base}&archived=false`,
    base,
  ];
  let lastErr: unknown = null;
  for (const url of tryUrls) {
    try {
      const data = await polymarketGetJson(url, { timeoutMs: 6_000 });
      if (Array.isArray(data)) return data;
      lastErr = new Error('gamma_bad_shape');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function gammaSearchMarkets(q: string, limitPerType: number, maxResults: number): Promise<unknown[]> {
  const url = `${GAMMA()}/public-search?q=${encodeURIComponent(q)}&limit_per_type=${limitPerType}`;
  const body = (await polymarketGetJson(url, { timeoutMs: 8_000 })) as Record<string, unknown>;
  const events = Array.isArray(body.events) ? body.events : [];
  const topMarkets = Array.isArray(body.markets) ? body.markets : [];
  const fromEvents = events.flatMap((e) => {
    const ev = e as Record<string, unknown>;
    return Array.isArray(ev.markets) ? ev.markets : [];
  });
  return [...topMarkets, ...fromEvents].slice(0, maxResults);
}

export async function gammaMarketBySlugOrId(slugOrId: string, opts?: { timeoutMs?: number }): Promise<unknown> {
  const numeric = /^\d+$/.test(slugOrId);
  const path = numeric ? `/markets/${slugOrId}` : `/markets/slug/${encodeURIComponent(slugOrId)}`;
  return polymarketGetJson(`${GAMMA()}${path}`, { timeoutMs: opts?.timeoutMs });
}
