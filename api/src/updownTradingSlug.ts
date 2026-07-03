import { clobHasBookCached, gammaMarketCached } from './updownCanonicalProbe.js';
import { parseClobTokenIds } from './polymarket/index.js';

/** Prior 5m bucket slug (`asset-updown-5m-<ts-300>`) when `liveSlug` is canonical. */
export function priorCanonicalUpdownSlug(liveSlug: string): string | null {
  const m = liveSlug.trim().toLowerCase().match(/^([a-z0-9]{2,10})-updown-5m-(\d+)$/);
  if (!m) return null;
  const ts = Number(m[2]);
  if (!Number.isFinite(ts) || ts < 300) return null;
  return `${m[1]}-updown-5m-${ts - 300}`;
}

/**
 * Slug the desk should load for trading: 5m prefers the prior bucket (settled PTB) when its CLOB
 * book is live; otherwise the shortcut's live window (avoids empty books right after roll).
 */
export async function resolveUpdownTradingSlug(liveSlug: string, interval: string): Promise<string> {
  const live = liveSlug.trim();
  if (!live || interval !== '5m') return live;
  const prior = priorCanonicalUpdownSlug(live);
  if (!prior) return live;
  try {
    const m = await gammaMarketCached(prior);
    if (!m) return live;
    const t0 = parseClobTokenIds(m.clobTokenIds ?? m.clob_token_ids)[0];
    if (t0 && (await clobHasBookCached(t0))) return prior;
  } catch {
    /* fall through */
  }
  return live;
}

export function stepSecForUpdownInterval(interval: string): number {
  if (interval === '15m') return 900;
  if (interval === '1h') return 3600;
  if (interval === '4h') return 4 * 3600;
  if (interval === '1d') return 24 * 3600;
  return 300;
}

function parseCanonicalUpdownSlugTs(slug: string): { interval: string; ts: number } | null {
  const m = slug.trim().toLowerCase().match(/^[a-z0-9]{2,10}-updown-(5m|15m|1h|4h|1d)-(\d+)$/);
  if (!m) return null;
  const ts = Number(m[2]);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return { interval: m[1]!, ts };
}

/** When `trading_slug` differs from shortcut `slug`, attach window metadata for the slug the desk opens. */
export function tradingWindowFieldsForSlug(tradingSlug: string, liveSlug: string): Record<string, unknown> {
  const trade = tradingSlug.trim();
  const live = liveSlug.trim();
  if (!trade || trade === live) return {};
  const parsed = parseCanonicalUpdownSlugTs(trade);
  if (!parsed) return {};
  const stepSec = stepSecForUpdownInterval(parsed.interval);
  const startSec = parsed.ts;
  const endSec = startSec + stepSec;
  return {
    trading_inferred_window_start_unix: startSec,
    trading_inferred_end_unix: endSec,
    trading_start: new Date(startSec * 1000).toISOString(),
    trading_end: new Date(endSec * 1000).toISOString(),
  };
}
