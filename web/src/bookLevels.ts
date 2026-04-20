export type BookLevel = { price: number; size: number };

const DIME = 0.1;

export function pickBookLevels(book: unknown): { bids: BookLevel[]; asks: BookLevel[] } {
  if (!book || typeof book !== 'object') return { bids: [], asks: [] };
  const anyBook = book as Record<string, unknown>;
  const bidsRaw = Array.isArray(anyBook.bids) ? anyBook.bids : [];
  const asksRaw = Array.isArray(anyBook.asks) ? anyBook.asks : [];
  const toLevel = (v: unknown): BookLevel | null => {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const price = Number(o.price ?? o.rate ?? o.value);
    const size = Number(o.size ?? o.shares ?? o.amount ?? o.quantity);
    if (!Number.isFinite(price) || !Number.isFinite(size)) return null;
    return { price, size };
  };
  const bids = bidsRaw.map(toLevel).filter((x): x is BookLevel => x !== null).sort((a, b) => b.price - a.price);
  const asks = asksRaw.map(toLevel).filter((x): x is BookLevel => x !== null).sort((a, b) => a.price - b.price);
  return {
    bids: bids.slice(0, 48),
    asks: asks.slice(0, 48),
  };
}

function dimeBucketStart(price: number): number {
  return Math.floor(price / DIME + 1e-12) * DIME;
}

export function groupLevelsByDime(
  levels: BookLevel[],
  tone: 'ask' | 'bid',
): { bandLo: number; bandHi: number; levels: BookLevel[] }[] {
  const map = new Map<number, BookLevel[]>();
  for (const l of levels) {
    const k = dimeBucketStart(l.price);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(l);
  }
  for (const arr of map.values()) {
    if (tone === 'ask') arr.sort((a, b) => a.price - b.price);
    else arr.sort((a, b) => b.price - a.price);
  }
  const keys = [...map.keys()].sort((a, b) => (tone === 'ask' ? a - b : b - a));
  return keys.map((k) => ({
    bandLo: k,
    bandHi: k + DIME,
    levels: map.get(k)!,
  }));
}

export function displayPrice(p: number): string {
  if (!Number.isFinite(p)) return '—';
  const t = p.toFixed(6).replace(/\.?0+$/, '');
  return t === '' ? '0' : t;
}

export function topOfBook(book: unknown): { bestBid: number | null; bestAsk: number | null } {
  const { bids, asks } = pickBookLevels(book);
  return { bestBid: bids[0]?.price ?? null, bestAsk: asks[0]?.price ?? null };
}

/** Mid from best bid/ask when both exist; else best available side (thin book). */
export function midPrice(book: unknown): number | null {
  const { bestBid, bestAsk } = topOfBook(book);
  if (bestBid != null && bestAsk != null) return (bestBid + bestAsk) / 2;
  if (bestBid != null) return bestBid;
  if (bestAsk != null) return bestAsk;
  return null;
}

export function spreadWidth(book: unknown): number | null {
  const { bestBid, bestAsk } = topOfBook(book);
  if (bestBid != null && bestAsk != null && bestAsk >= bestBid) return bestAsk - bestBid;
  return null;
}
