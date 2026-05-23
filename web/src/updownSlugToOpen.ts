import { clobBook, marketsGet, type ApiErr, type ApiOk, type UpdownInterval } from './lib/api';
import { slugFromUpdownShortcutResponse } from './sixPackUpdownSlugs';

function isOk<T>(res: ApiOk<T> | ApiErr): res is ApiOk<T> {
  return (res as ApiOk<T>).ok === true;
}

function pickTokenIds(market: unknown): string[] {
  if (!market || typeof market !== 'object') return [];
  const o = market as Record<string, unknown>;
  const ids = o.clob_token_ids ?? o.clobTokenIds;
  if (Array.isArray(ids)) return ids.map(String).filter(Boolean);
  if (typeof ids === 'string') {
    const t = ids.trim();
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t) as unknown;
        if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
      } catch {
        /* fall through */
      }
    }
    return t.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function bookHasLiquidity(book: unknown): boolean {
  if (!book || typeof book !== 'object') return false;
  const b = book as Record<string, unknown>;
  const bids = Array.isArray(b.bids) ? b.bids : [];
  const asks = Array.isArray(b.asks) ? b.asks : [];
  return bids.length > 0 || asks.length > 0;
}

/** Slug to load after shortcut — uses API `trading_slug` when present, else verifies prior 5m has a CLOB book. */
export async function updownSlugToOpen(
  data: { slug: string; trading_slug?: string },
  interval: UpdownInterval,
): Promise<string> {
  const live = data.slug.trim();
  const candidate = slugFromUpdownShortcutResponse(data, interval);
  if (interval !== '5m' || candidate === live) return candidate;
  if (data.trading_slug?.trim()) return candidate;

  const m = await marketsGet(candidate);
  if (!isOk(m)) return live;
  const t0 = pickTokenIds(m.data)[0];
  if (!t0) return live;
  const bk = await clobBook(t0);
  if (!isOk(bk) || !bookHasLiquidity(bk.data)) return live;
  return candidate;
}
