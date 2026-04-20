import { pickBookLevels, type BookLevel } from './bookLevels';

export type BookSnapshot = {
  t: number;
  mid: number | null;
  spread: number | null;
  bidDepth: number;
  askDepth: number;
  imbalance: number | null; // [-1,1]
  churn: number | null; // sum abs size delta across tracked levels
};

function sumTop(levels: BookLevel[], n: number): number {
  let s = 0;
  for (let i = 0; i < Math.min(n, levels.length); i++) s += levels[i]!.size;
  return s;
}

function keyPrice(p: number): string {
  // quantize to avoid float noise in map keys
  return p.toFixed(6);
}

function toSizeMap(levels: BookLevel[], n: number): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < Math.min(n, levels.length); i++) {
    const l = levels[i]!;
    m.set(keyPrice(l.price), l.size);
  }
  return m;
}

function churnFrom(prev: Map<string, number> | null, next: Map<string, number>): number | null {
  if (!prev) return null;
  const keys = new Set<string>([...prev.keys(), ...next.keys()]);
  let sumAbs = 0;
  for (const k of keys) {
    const a = prev.get(k) ?? 0;
    const b = next.get(k) ?? 0;
    sumAbs += Math.abs(b - a);
  }
  return sumAbs;
}

export function snapshotFromBook(
  book: unknown,
  t: number,
  prev?: { bids: Map<string, number>; asks: Map<string, number> } | null,
  opts?: { depthLevels?: number },
): { snap: BookSnapshot; next: { bids: Map<string, number>; asks: Map<string, number> } } {
  const depthLevels = opts?.depthLevels ?? 12;
  const { bids, asks } = pickBookLevels(book);

  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk ?? null;
  const spread = bestBid != null && bestAsk != null && bestAsk >= bestBid ? bestAsk - bestBid : null;

  const bidDepth = sumTop(bids, depthLevels);
  const askDepth = sumTop(asks, depthLevels);
  const denom = bidDepth + askDepth;
  const imbalance = denom > 0 ? (bidDepth - askDepth) / denom : null;

  const nextBids = toSizeMap(bids, depthLevels);
  const nextAsks = toSizeMap(asks, depthLevels);
  const churnBid = churnFrom(prev?.bids ?? null, nextBids);
  const churnAsk = churnFrom(prev?.asks ?? null, nextAsks);
  const churn = churnBid == null || churnAsk == null ? null : churnBid + churnAsk;

  return {
    snap: { t, mid, spread, bidDepth, askDepth, imbalance, churn },
    next: { bids: nextBids, asks: nextAsks },
  };
}

