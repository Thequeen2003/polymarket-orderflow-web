import { pickBookLevels, type BookLevel } from './bookLevels';
import { estimateNet4cLong } from './executionEstimator';
import type { DataTradeRow } from './lib/api';
import type { SixPackKey } from './sixPackUpdownSlugs';

/** Rolling max of mid for the outcome token — last N polls (~1 min at 5s cadence). */
export const DEFAULT_REF_MID_WINDOW = 12;

export const PAPER_LS_KEY = 'bp_paper_smart_money_v1';

export type PaperLane = 'up' | 'down';

export type PaperOrderSide = 'buy' | 'sell';
export type PaperOrderStatus = 'open' | 'filled' | 'cancelled';

export type PaperOrder = {
  id: string;
  side: PaperOrderSide;
  lane: PaperLane;
  token: string;
  price: number;
  shares: number;
  status: PaperOrderStatus;
  createdAtMs: number;
  filledAtMs?: number;
};

export type PaperOpenPosition = {
  lane: PaperLane;
  entryMid: number;
  entryAtMs: number;
  token: string;
  shares: number;
};

export type PaperEvent = {
  t: number;
  key: SixPackKey;
  kind: 'open' | 'close' | 'roll_close' | 'skip';
  slug: string;
  lane?: PaperLane;
  detail: string;
  pnl01?: number | null;
};

export type PaperMarketConfig = {
  /** Min |upNet − downNet| tape notional edge (sum of price×size on prints). */
  minTapeSkew: number;
  /** Buy when mid ≤ refHigh − buyBelowEdge (price units; 0.02 = 2¢). */
  buyBelowEdge: number;
  takeProfit: number;
  minEndsInMs: number;
  refMidWindow: number;
  refShares: number;
  requireNet4c: boolean;
  requireBookAlign: boolean;
  /** When |imbalance| below this, skip book-align gate (treat as unknown). */
  bookAlignMinAbs: number;

  /** Ladder bid prices (absolute price levels) for the “cheap bid stack” pattern. */
  ladderPrices: number[];
  /** Shares per ladder order. */
  ladderClipShares: number;
};

export const DEFAULT_PAPER_CONFIG: PaperMarketConfig = {
  minTapeSkew: 3,
  buyBelowEdge: 0.02,
  takeProfit: 0.03,
  minEndsInMs: 45_000,
  refMidWindow: DEFAULT_REF_MID_WINDOW,
  refShares: 50,
  requireNet4c: true,
  requireBookAlign: false,
  bookAlignMinAbs: 0.04,
  ladderPrices: [0.04, 0.05, 0.08, 0.09, 0.1, 0.15, 0.17],
  ladderClipShares: 20,
};

export type PaperPersistedV1 = {
  v: 1;
  byKey: Partial<
    Record<
      SixPackKey,
      {
        lastSlug: string;
        pos: PaperOpenPosition | null;
        orders: PaperOrder[];
      }
    >
  >;
  eventTail: PaperEvent[];
};

const MAX_EVENTS = 200;

export function aggregateTapeNet(rows: DataTradeRow[]): { buyN: number; sellN: number; net: number } {
  let buyN = 0;
  let sellN = 0;
  for (const r of rows) {
    const p = r.price;
    const s = r.size;
    if (p == null || s == null || !Number.isFinite(p) || !Number.isFinite(s)) continue;
    const n = p * s;
    const side = String(r.side || '').toUpperCase();
    if (side === 'BUY') buyN += n;
    else if (side === 'SELL') sellN += n;
  }
  return { buyN, sellN, net: buyN - sellN };
}

export function tapeLean(
  upRows: DataTradeRow[],
  downRows: DataTradeRow[],
  minSkew: number,
): { lean: PaperLane | null; upNet: number; downNet: number; diff: number } {
  const u = aggregateTapeNet(upRows);
  const d = aggregateTapeNet(downRows);
  const diff = u.net - d.net;
  if (diff > minSkew) return { lean: 'up', upNet: u.net, downNet: d.net, diff };
  if (diff < -minSkew) return { lean: 'down', upNet: u.net, downNet: d.net, diff };
  return { lean: null, upNet: u.net, downNet: d.net, diff };
}

export function rollingRefHigh(mids: (number | null)[], window: number): number | null {
  const slice = mids.slice(-window);
  let best: number | null = null;
  for (const m of slice) {
    if (m == null || !Number.isFinite(m)) continue;
    if (best == null || m > best) best = m;
  }
  return best;
}

function depthImbalance01(book: unknown): number | null {
  const { bids, asks } = pickBookLevels(book);
  const n = 12;
  let bd = 0;
  let ad = 0;
  for (let i = 0; i < n; i++) {
    bd += bids[i]?.size ?? 0;
    ad += asks[i]?.size ?? 0;
  }
  const den = bd + ad;
  return den > 0 ? (bd - ad) / den : null;
}

function bookForNet4c(lane: PaperLane, upBook: unknown, downBook: unknown): { asks: BookLevel[]; bids: BookLevel[] } {
  const b = lane === 'up' ? upBook : downBook;
  const { asks, bids } = pickBookLevels(b);
  return { asks, bids };
}

export type StepInput = {
  now: number;
  key: SixPackKey;
  slug: string;
  lastSlug: string | null;
  upBook: unknown;
  downBook: unknown;
  upTokenId: string;
  downTokenId: string;
  upMid: number | null;
  downMid: number | null;
  upMidHistory: (number | null)[];
  downMidHistory: (number | null)[];
  upRows: DataTradeRow[];
  downRows: DataTradeRow[];
  endsInMs: number | null;
  pos: PaperOpenPosition | null;
  cfg: PaperMarketConfig;
};

export type StepResult = {
  nextPos: PaperOpenPosition | null;
  nextLastSlug: string;
  events: PaperEvent[];
};

function laneBook(lane: PaperLane, upBook: unknown, downBook: unknown): unknown {
  return lane === 'up' ? upBook : downBook;
}

function laneMid(lane: PaperLane, upMid: number | null, downMid: number | null): number | null {
  return lane === 'up' ? upMid : downMid;
}

function laneHistory(lane: PaperLane, upMidHistory: (number | null)[], downMidHistory: (number | null)[]): (number | null)[] {
  return lane === 'up' ? upMidHistory : downMidHistory;
}

function bestBidAsk(book: unknown): { bid: number | null; ask: number | null } {
  const { bids, asks } = pickBookLevels(book);
  const bid = bids[0]?.price ?? null;
  const ask = asks[0]?.price ?? null;
  return { bid, ask };
}

function orderId(now: number, key: SixPackKey, lane: PaperLane, side: PaperOrderSide, price: number): string {
  return `${key}:${lane}:${side}:${Math.round(price * 1000)}:${now}`;
}

/**
 * One decision step: roll detection, exit rules, or entry (tape skew + buy-below vs ref high).
 */
export function stepPaperMarket(inp: StepInput): StepResult {
  const { now, key, slug, lastSlug, pos, cfg } = inp;
  const events: PaperEvent[] = [];
  let working = pos;

  if (working && lastSlug && lastSlug !== slug) {
    const mid = laneMid(working.lane, inp.upMid, inp.downMid);
    const pnl = mid != null && Number.isFinite(mid) ? mid - working.entryMid : null;
    events.push({
      t: now,
      key,
      kind: 'roll_close',
      slug: lastSlug,
      lane: working.lane,
      detail: 'market bucket rolled — flat paper position',
      pnl01: pnl,
    });
    working = null;
  }

  if (working) {
    const mid = laneMid(working.lane, inp.upMid, inp.downMid);
    if (mid == null || !Number.isFinite(mid)) {
      return { nextPos: working, nextLastSlug: slug, events };
    }
    if (mid >= working.entryMid + cfg.takeProfit) {
      const pnl = mid - working.entryMid;
      events.push({
        t: now,
        key,
        kind: 'close',
        slug,
        lane: working.lane,
        detail: 'take profit (mid vs entry)',
        pnl01: pnl,
      });
      return { nextPos: null, nextLastSlug: slug, events };
    }
    const { lean } = tapeLean(inp.upRows, inp.downRows, cfg.minTapeSkew);
    if (lean != null && lean !== working.lane) {
      const pnl = mid - working.entryMid;
      events.push({
        t: now,
        key,
        kind: 'close',
        slug,
        lane: working.lane,
        detail: 'tape skew flipped',
        pnl01: pnl,
      });
      return { nextPos: null, nextLastSlug: slug, events };
    }
    if (inp.endsInMs != null && inp.endsInMs < cfg.minEndsInMs) {
      const pnl = mid - working.entryMid;
      events.push({
        t: now,
        key,
        kind: 'close',
        slug,
        lane: working.lane,
        detail: 'time stop (window almost done)',
        pnl01: pnl,
      });
      return { nextPos: null, nextLastSlug: slug, events };
    }
    return { nextPos: working, nextLastSlug: slug, events };
  }

  const { lean } = tapeLean(inp.upRows, inp.downRows, cfg.minTapeSkew);
  if (lean == null) {
    return { nextPos: null, nextLastSlug: slug, events };
  }

  const m = laneMid(lean, inp.upMid, inp.downMid);
  const ref = rollingRefHigh(laneHistory(lean, inp.upMidHistory, inp.downMidHistory), cfg.refMidWindow);
  if (m == null || !Number.isFinite(m) || ref == null) {
    return { nextPos: null, nextLastSlug: slug, events };
  }

  if (m > ref - cfg.buyBelowEdge) {
    return { nextPos: null, nextLastSlug: slug, events };
  }

  if (cfg.requireBookAlign) {
    const b = laneBook(lean, inp.upBook, inp.downBook);
    const im = depthImbalance01(b);
    if (im == null || Math.abs(im) < cfg.bookAlignMinAbs) {
      return { nextPos: null, nextLastSlug: slug, events };
    }
    if (lean === 'up' && im < 0) return { nextPos: null, nextLastSlug: slug, events };
    if (lean === 'down' && im > 0) return { nextPos: null, nextLastSlug: slug, events };
  }

  if (cfg.requireNet4c) {
    const { asks, bids } = bookForNet4c(lean, inp.upBook, inp.downBook);
    const n4 = estimateNet4cLong({ asks, bids, shares: cfg.refShares, maxLevels: 18 });
    if (!n4.ok) {
      return { nextPos: null, nextLastSlug: slug, events };
    }
  }

  const tokenBook = laneBook(lean, inp.upBook, inp.downBook);
  const { bids, asks } = pickBookLevels(tokenBook);
  const tokenId = lean === 'up' ? inp.upTokenId : inp.downTokenId;
  const open: PaperOpenPosition = {
    lane: lean,
    entryMid: m,
    entryAtMs: now,
    token: tokenId,
    shares: cfg.refShares,
  };
  void bids;
  void asks;

  events.push({
    t: now,
    key,
    kind: 'open',
    slug,
    lane: lean,
    detail: `paper buy (smart-money lean ${lean}, buy-below ref ${(ref * 100).toFixed(1)}¢)`,
  });
  return { nextPos: open, nextLastSlug: slug, events };
}

function emptyPersist(): PaperPersistedV1 {
  return { v: 1, byKey: {}, eventTail: [] };
}

export function loadPaperState(): PaperPersistedV1 {
  if (typeof localStorage === 'undefined') return emptyPersist();
  try {
    const raw = localStorage.getItem(PAPER_LS_KEY);
    if (!raw) return emptyPersist();
    const o = JSON.parse(raw) as PaperPersistedV1;
    if (o.v !== 1 || typeof o !== 'object' || o == null) return emptyPersist();
    const byKey = o.byKey ?? {};
    // Back-compat: ensure orders array exists.
    for (const k of Object.keys(byKey) as SixPackKey[]) {
      const v = byKey[k];
      if (!v) continue;
      if (!Array.isArray((v as { orders?: unknown }).orders)) (v as { orders: PaperOrder[] }).orders = [];
    }
    return { v: 1, byKey, eventTail: Array.isArray(o.eventTail) ? o.eventTail : [] };
  } catch {
    return emptyPersist();
  }
}

export function savePaperState(s: PaperPersistedV1): void {
  try {
    localStorage.setItem(PAPER_LS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function pushEvents(tail: PaperEvent[], more: PaperEvent[], max: number = MAX_EVENTS): PaperEvent[] {
  const next = [...tail, ...more];
  return next.slice(-max);
}

export type StepWithOrdersInput = StepInput & {
  orders: PaperOrder[];
};

export type StepWithOrdersResult = StepResult & {
  nextOrders: PaperOrder[];
};

/**
 * Adds explicit paper open-order tracking:
 * - Maintains a ladder of limit buys on the tape-lean lane.
 * - Fills buys when best ask touches; opens a position.
 * - Creates a take-profit sell order for open positions; fills when best bid touches.
 */
export function stepPaperMarketWithOrders(inp: StepWithOrdersInput): StepWithOrdersResult {
  const { now, key, slug, lastSlug, cfg } = inp;
  const events: PaperEvent[] = [];
  let pos = inp.pos;
  let orders = (inp.orders ?? []).filter((o) => o && o.status === 'open');

  const upBA = bestBidAsk(inp.upBook);
  const dnBA = bestBidAsk(inp.downBook);
  const laneBA = (lane: PaperLane) => (lane === 'up' ? upBA : dnBA);
  const laneTok = (lane: PaperLane) => (lane === 'up' ? inp.upTokenId : inp.downTokenId);

  // Roll detection: cancel orders + close position.
  if ((pos || orders.length) && lastSlug && lastSlug !== slug) {
    if (pos) {
      const mid = laneMid(pos.lane, inp.upMid, inp.downMid);
      const pnl = mid != null && Number.isFinite(mid) ? mid - pos.entryMid : null;
      events.push({ t: now, key, kind: 'roll_close', slug: lastSlug, lane: pos.lane, detail: 'market bucket rolled — flat paper position', pnl01: pnl });
      pos = null;
    }
    if (orders.length) {
      orders = orders.map((o) => ({ ...o, status: 'cancelled' as const }));
      events.push({ t: now, key, kind: 'skip', slug: lastSlug, detail: 'market bucket rolled — cancelled open paper orders' });
      orders = [];
    }
  }

  // If we have an open position, manage TP sell + exits.
  if (pos) {
    const cur = pos;
    const tpPrice = Math.max(0.01, Math.min(0.99, cur.entryMid + cfg.takeProfit));
    const token = laneTok(cur.lane);
    const existingSell = orders.find((o) => o.side === 'sell' && o.lane === cur.lane && o.token === token);
    if (!existingSell) {
      orders.push({
        id: orderId(now, key, cur.lane, 'sell', tpPrice),
        side: 'sell',
        lane: cur.lane,
        token,
        price: tpPrice,
        shares: cur.shares,
        status: 'open',
        createdAtMs: now,
      });
    }

    const { bid } = laneBA(cur.lane);
    const sell = orders.find((o) => o.side === 'sell' && o.lane === cur.lane && o.token === token);
    if (sell && bid != null && Number.isFinite(bid) && bid >= sell.price) {
      const pnl = sell.price - cur.entryMid;
      events.push({ t: now, key, kind: 'close', slug, lane: cur.lane, detail: 'take profit (paper limit sell filled)', pnl01: pnl });
      orders = orders.filter((o) => o.id !== sell.id);
      pos = null;
      return { nextPos: pos, nextLastSlug: slug, nextOrders: orders, events };
    }

    const { lean } = tapeLean(inp.upRows, inp.downRows, cfg.minTapeSkew);
    if (lean != null && lean !== cur.lane) {
      const mid = laneMid(cur.lane, inp.upMid, inp.downMid);
      const pnl = mid != null && Number.isFinite(mid) ? mid - cur.entryMid : null;
      events.push({ t: now, key, kind: 'close', slug, lane: cur.lane, detail: 'tape skew flipped (paper close)', pnl01: pnl });
      orders = orders.filter((o) => !(o.side === 'sell' && o.lane === cur.lane));
      pos = null;
      return { nextPos: pos, nextLastSlug: slug, nextOrders: orders, events };
    }

    if (inp.endsInMs != null && inp.endsInMs < cfg.minEndsInMs) {
      const mid = laneMid(cur.lane, inp.upMid, inp.downMid);
      const pnl = mid != null && Number.isFinite(mid) ? mid - cur.entryMid : null;
      events.push({ t: now, key, kind: 'close', slug, lane: cur.lane, detail: 'time stop (paper close)', pnl01: pnl });
      orders = orders.filter((o) => !(o.side === 'sell' && o.lane === cur.lane));
      pos = null;
      return { nextPos: pos, nextLastSlug: slug, nextOrders: orders, events };
    }

    return { nextPos: cur, nextLastSlug: slug, nextOrders: orders, events };
  }

  // No position: maintain ladder orders on current lean lane.
  const { lean } = tapeLean(inp.upRows, inp.downRows, cfg.minTapeSkew);
  if (lean == null) {
    // If no lean, don’t maintain orders.
    if (orders.length) {
      orders = [];
      events.push({ t: now, key, kind: 'skip', slug, detail: 'no tape lean — cleared open paper orders' });
    }
    return { nextPos: null, nextLastSlug: slug, nextOrders: orders, events };
  }

  const token = laneTok(lean);
  const allowedRef = rollingRefHigh(laneHistory(lean, inp.upMidHistory, inp.downMidHistory), cfg.refMidWindow);
  // Gate ladder creation on having a ref high (so “buy-below” has meaning).
  if (allowedRef == null) return { nextPos: null, nextLastSlug: slug, nextOrders: orders, events };

  // Ensure ladder buy orders exist.
  const ladder = cfg.ladderPrices
    .filter((p) => Number.isFinite(p) && p > 0 && p < 1)
    .map((p) => Math.round(p * 1000) / 1000);

  const existingBuys = new Set(orders.filter((o) => o.side === 'buy' && o.lane === lean && o.token === token).map((o) => Math.round(o.price * 1000)));
  for (const px of ladder) {
    const kpx = Math.round(px * 1000);
    if (existingBuys.has(kpx)) continue;
    orders.push({
      id: orderId(now, key, lean, 'buy', px),
      side: 'buy',
      lane: lean,
      token,
      price: px,
      shares: cfg.ladderClipShares,
      status: 'open',
      createdAtMs: now,
    });
  }

  // Fill logic: any buy whose price >= best ask fills.
  const { ask } = laneBA(lean);
  if (ask != null && Number.isFinite(ask)) {
    const fillable = orders
      .filter((o) => o.side === 'buy' && o.lane === lean && o.token === token && ask <= o.price)
      .sort((a, b) => b.price - a.price);
    if (fillable.length) {
      const f = fillable[0]!;
      // Optional +4¢ gate: evaluate net4c on current ladder lane before accepting fill.
      if (cfg.requireNet4c) {
        const { asks, bids } = bookForNet4c(lean, inp.upBook, inp.downBook);
        const n4 = estimateNet4cLong({ asks, bids, shares: cfg.refShares, maxLevels: 18 });
        if (!n4.ok) return { nextPos: null, nextLastSlug: slug, nextOrders: orders, events };
      }

      events.push({ t: now, key, kind: 'open', slug, lane: lean, detail: `paper limit buy filled @ ${(f.price * 100).toFixed(1)}¢` });
      orders = orders.filter((o) => o.id !== f.id);
      return {
        nextPos: { lane: lean, entryMid: f.price, entryAtMs: now, token, shares: f.shares },
        nextLastSlug: slug,
        nextOrders: orders,
        events,
      };
    }
  }

  return { nextPos: null, nextLastSlug: slug, nextOrders: orders, events };
}