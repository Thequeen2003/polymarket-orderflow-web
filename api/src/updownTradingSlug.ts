import { gammaMarketCached } from './updownCanonicalProbe.js';
import { clobHasOrderbook, parseClobTokenIds } from './polymarket/index.js';

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
    if (m.closed === true || m.active === false) return live;
    const t0 = parseClobTokenIds(m.clobTokenIds ?? m.clob_token_ids)[0];
    // Fresh CLOB probe — cached "has book" can lag after a 5m roll and strand the desk on 404 books.
    if (t0 && (await clobHasOrderbook(t0))) return prior;
  } catch {
    /* fall through */
  }
  return live;
}
