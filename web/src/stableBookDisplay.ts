import type { BookLevel } from './bookLevels';

const DEFAULT_SIZE_ALPHA = 0.38;
const DEFAULT_MAX_ALPHA = 0.28;

function priceKey(p: number): string {
  return p.toFixed(6);
}

/** EMA per price level — sizes ease toward new values instead of snapping. */
export function smoothBookLevels(
  prevSizes: Map<string, number> | null,
  levels: BookLevel[],
  alpha = DEFAULT_SIZE_ALPHA,
): { levels: BookLevel[]; sizes: Map<string, number> } {
  const sizes = new Map<string, number>();
  const out: BookLevel[] = [];
  for (const l of levels) {
    if (!Number.isFinite(l.price) || !Number.isFinite(l.size)) continue;
    const k = priceKey(l.price);
    const prev = prevSizes?.get(k);
    const size = prev != null ? prev * (1 - alpha) + l.size * alpha : l.size;
    sizes.set(k, size);
    out.push({ price: l.price, size });
  }
  return { levels: out, sizes };
}

/** EMA for bar-scale max depth — stops width flicker when one tick hammers size. */
export function smoothDepthMax(prev: number, rawMax: number, alpha = DEFAULT_MAX_ALPHA): number {
  const next = Math.max(1, rawMax);
  if (!Number.isFinite(prev) || prev <= 0) return next;
  return prev * (1 - alpha) + next * alpha;
}

export type StableBookLadderState = {
  bids: BookLevel[];
  asks: BookLevel[];
  maxBid: number;
  maxAsk: number;
  bidSizes: Map<string, number>;
  askSizes: Map<string, number>;
};

export function updateStableBookLadder(
  prev: StableBookLadderState | null,
  raw: { bids: BookLevel[]; asks: BookLevel[] },
  maxLevels = 12,
): StableBookLadderState {
  const bidsRaw = raw.bids.slice(0, maxLevels);
  const asksRaw = raw.asks.slice(0, maxLevels);

  const bidSmooth = smoothBookLevels(prev?.bidSizes ?? null, bidsRaw);
  const askSmooth = smoothBookLevels(prev?.askSizes ?? null, asksRaw);

  const rawMaxBid = Math.max(1, ...bidSmooth.levels.map((l) => l.size));
  const rawMaxAsk = Math.max(1, ...askSmooth.levels.map((l) => l.size));

  return {
    bids: bidSmooth.levels,
    asks: askSmooth.levels,
    maxBid: smoothDepthMax(prev?.maxBid ?? 0, rawMaxBid),
    maxAsk: smoothDepthMax(prev?.maxAsk ?? 0, rawMaxAsk),
    bidSizes: bidSmooth.sizes,
    askSizes: askSmooth.sizes,
  };
}

export type ClobWsBookLevel = { price: string; size: string };

/** Never replace a multi-level book with a 1-tick BBA snapshot (major source of ladder jump). */
export function mergeWsBestBidAsk(
  existing: { bids: ClobWsBookLevel[]; asks: ClobWsBookLevel[] } | undefined,
  best: { bestBid: string; bestAsk: string },
): { bids: ClobWsBookLevel[]; asks: ClobWsBookLevel[] } {
  const depth = (existing?.bids.length ?? 0) + (existing?.asks.length ?? 0);
  if (depth >= 4) return existing!;

  const bids = [...(existing?.bids ?? [])];
  const asks = [...(existing?.asks ?? [])];

  if (best.bestBid && best.bestBid !== '0') {
    if (!bids.some((l) => l.price === best.bestBid)) {
      bids.unshift({ price: best.bestBid, size: bids[0]?.size ?? '1' });
    }
  }
  if (best.bestAsk && best.bestAsk !== '0') {
    if (!asks.some((l) => l.price === best.bestAsk)) {
      asks.unshift({ price: best.bestAsk, size: asks[0]?.size ?? '1' });
    }
  }

  return { bids, asks };
}
