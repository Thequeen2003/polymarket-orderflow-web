export type PaperTradeSide = 'buy' | 'sell';

export type PaperPosition = {
  shares: number;
  avgCost01: number | null; // probability-like price (0..1)
};

export type PaperOrder = {
  id: string;
  tokenId: string;
  side: PaperTradeSide;
  /** Limit price (0..1) */
  limit01: number;
  shares: number;
  createdAt: number;
};

export type PaperAccount = {
  cashUsdCents: number;
  realizedPnlUsdCents: number;
  positionsByToken: Record<string, PaperPosition>;
  updatedAt: number;
};

const STORAGE_KEY = 'pmof.paperAccount.v1';
const ORDERS_KEY = 'pmof.paperOrders.v1';
const STARTING_CASH_USD_CENTS = 5000 * 100;

/** Limit float dust in stored share balances (Polymarket-scale lots). */
const SHARES_DECIMALS = 6;
const SHARES_SCALE = 10 ** SHARES_DECIMALS;
/** Reject sells smaller than this (avoids “0.00 sh” filled rows from float residue). */
const MIN_SELL_SHARES = 1e-4;

function roundPositionShares(x: number): number {
  const y = Math.round(x * SHARES_SCALE) / SHARES_SCALE;
  return Math.abs(y) < 1 / SHARES_SCALE ? 0 : y;
}

export function freshPaperAccount(now = Date.now()): PaperAccount {
  return {
    cashUsdCents: STARTING_CASH_USD_CENTS,
    realizedPnlUsdCents: 0,
    positionsByToken: {},
    updatedAt: now,
  };
}

export function loadPaperAccount(): PaperAccount {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshPaperAccount();
    const parsed = JSON.parse(raw) as Partial<PaperAccount> | null;
    if (!parsed || typeof parsed !== 'object') return freshPaperAccount();
    const a = freshPaperAccount();
    const cash = Number(parsed.cashUsdCents);
    const realized = Number(parsed.realizedPnlUsdCents);
    a.cashUsdCents = Number.isFinite(cash) ? cash : a.cashUsdCents;
    a.realizedPnlUsdCents = Number.isFinite(realized) ? realized : a.realizedPnlUsdCents;
    a.positionsByToken = parsed.positionsByToken && typeof parsed.positionsByToken === 'object' ? (parsed.positionsByToken as any) : {};
    a.updatedAt = typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : Date.now();
    return a;
  } catch {
    return freshPaperAccount();
  }
}

export function savePaperAccount(a: PaperAccount): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
  } catch {
    /* ignore */
  }
}

export function resetPaperAccount(): PaperAccount {
  const next = freshPaperAccount();
  savePaperAccount(next);
  return next;
}

export function getPaperPosition(a: PaperAccount, tokenId: string): PaperPosition {
  const t = String(tokenId ?? '').trim();
  if (!t) return { shares: 0, avgCost01: null };
  const p = a.positionsByToken[t];
  if (!p) return { shares: 0, avgCost01: null };
  const rawShares = Number.isFinite(Number(p.shares)) ? Math.max(0, Number(p.shares)) : 0;
  return {
    shares: roundPositionShares(rawShares),
    avgCost01: p.avgCost01 == null ? null : Number.isFinite(Number(p.avgCost01)) ? Math.max(0, Math.min(1, Number(p.avgCost01))) : null,
  };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function randomId(): string {
  try {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    return `${a[0]!.toString(16)}${a[1]!.toString(16)}`;
  } catch {
    return String(Math.floor(Math.random() * 1e12));
  }
}

function usdCentsForTrade(price01: number, shares: number): number {
  // USD cents = price * shares * 100
  return Math.round(clamp01(price01) * shares * 100);
}

export function loadPaperOrders(): PaperOrder[] {
  try {
    const raw = window.localStorage.getItem(ORDERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => x as Partial<PaperOrder>)
      .filter((o) => o && typeof o === 'object')
      .map((o): PaperOrder | null => {
        const id = String(o.id ?? '');
        const tokenId = String(o.tokenId ?? '').trim();
        const side = String(o.side ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy';
        const limit01 = Number(o.limit01);
        const shares = Number(o.shares);
        const createdAt = Number(o.createdAt);
        if (!id || !tokenId) return null;
        if (!Number.isFinite(limit01) || limit01 <= 0 || limit01 >= 1) return null;
        if (!Number.isFinite(shares) || shares <= 0) return null;
        return {
          id,
          tokenId,
          side,
          limit01: clamp01(limit01),
          shares,
          createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        };
      })
      .filter((x): x is PaperOrder => x != null)
      .slice(0, 250);
  } catch {
    return [];
  }
}

export function savePaperOrders(orders: PaperOrder[]): void {
  try {
    window.localStorage.setItem(ORDERS_KEY, JSON.stringify(orders.slice(0, 250)));
  } catch {
    /* ignore */
  }
}

export function addPaperOrder(args: { tokenId: string; side: PaperTradeSide; limit01: number; shares: number; now?: number }): PaperOrder {
  const o: PaperOrder = {
    id: randomId(),
    tokenId: String(args.tokenId ?? '').trim(),
    side: args.side,
    limit01: clamp01(args.limit01),
    shares: args.shares,
    createdAt: args.now ?? Date.now(),
  };
  const orders = loadPaperOrders();
  savePaperOrders([o, ...orders]);
  return o;
}

export function cancelPaperOrder(id: string): PaperOrder[] {
  const orders = loadPaperOrders();
  const next = orders.filter((o) => o.id !== id);
  savePaperOrders(next);
  return next;
}

function isMarketable(order: PaperOrder, mid01: number): boolean {
  const mid = clamp01(mid01);
  if (order.side === 'buy') return mid <= order.limit01;
  return mid >= order.limit01;
}

export function matchPaperOrders(args: {
  account: PaperAccount;
  tokenId: string;
  mid01: number | null;
  now?: number;
}):
  | { ok: true; account: PaperAccount; filled: { order: PaperOrder; fillPrice01: number; usdCents: number }[]; remaining: PaperOrder[] }
  | { ok: false; error: string; remaining: PaperOrder[] } {
  const tokenId = String(args.tokenId ?? '').trim();
  if (!tokenId) return { ok: false, error: 'missing_token', remaining: loadPaperOrders() };
  const mid01 = args.mid01;
  if (mid01 == null || !Number.isFinite(mid01) || mid01 <= 0 || mid01 >= 1) return { ok: true, account: args.account, filled: [], remaining: loadPaperOrders() };

  const orders = loadPaperOrders();
  const remaining: PaperOrder[] = [];
  const filled: { order: PaperOrder; fillPrice01: number; usdCents: number }[] = [];

  let account = args.account;
  for (const o of orders) {
    if (o.tokenId !== tokenId) {
      remaining.push(o);
      continue;
    }
    if (!isMarketable(o, mid01)) {
      remaining.push(o);
      continue;
    }
    // Fill at the better of (mid, limit) for the taker.
    const px = o.side === 'buy' ? Math.min(clamp01(mid01), o.limit01) : Math.max(clamp01(mid01), o.limit01);
    const r = paperTrade({ account, tokenId: o.tokenId, side: o.side, shares: o.shares, price01: px, now: args.now });
    if (!r.ok) {
      // If fill fails (insufficient cash/shares), keep it resting.
      remaining.push(o);
      continue;
    }
    account = r.account;
    filled.push({ order: o, fillPrice01: r.fill.price01, usdCents: r.fill.usdCents });
  }

  savePaperOrders(remaining);
  return { ok: true, account, filled, remaining };
}

export type PaperTradeResult =
  | { ok: true; account: PaperAccount; fill: { token: string; side: PaperTradeSide; price01: number; shares: number; usdCents: number } }
  | { ok: false; error: string };

export function paperTrade(args: {
  account: PaperAccount;
  tokenId: string;
  side: PaperTradeSide;
  shares: number;
  price01: number | null;
  now?: number;
}): PaperTradeResult {
  const token = String(args.tokenId ?? '').trim();
  if (!token) return { ok: false, error: 'missing_token' };
  const shares = Number(args.shares);
  if (!Number.isFinite(shares) || shares <= 0) return { ok: false, error: 'invalid_shares' };
  const price01 = args.price01;
  if (price01 == null || !Number.isFinite(price01) || price01 <= 0 || price01 >= 1) return { ok: false, error: 'invalid_price' };

  const next: PaperAccount = JSON.parse(JSON.stringify(args.account)) as PaperAccount;
  next.updatedAt = args.now ?? Date.now();
  if (!next.positionsByToken) next.positionsByToken = {};
  if (!next.positionsByToken[token]) next.positionsByToken[token] = { shares: 0, avgCost01: null };
  const pos = next.positionsByToken[token];

  if (args.side === 'buy') {
    const usdCents = usdCentsForTrade(price01, shares);
    if (usdCents > next.cashUsdCents) return { ok: false, error: 'insufficient_cash' };
    next.cashUsdCents -= usdCents;
    const prevShares = roundPositionShares(Number(pos.shares) || 0);
    const prevAvg = pos.avgCost01 == null ? price01 : Number(pos.avgCost01);
    const nextShares = roundPositionShares(prevShares + shares);
    const nextAvg = (prevAvg * prevShares + price01 * shares) / Math.max(1e-9, nextShares);
    pos.shares = nextShares;
    pos.avgCost01 = clamp01(nextAvg);
    savePaperAccount(next);
    return { ok: true, account: next, fill: { token, side: args.side, price01: clamp01(price01), shares, usdCents } };
  }

  const prevShares = roundPositionShares(Number(pos.shares) || 0);
  const eff = roundPositionShares(Math.min(shares, prevShares));
  if (!Number.isFinite(eff) || eff < MIN_SELL_SHARES) {
    return { ok: false, error: 'Nothing to sell (position is flat or below minimum size).' };
  }
  const usdCents = usdCentsForTrade(price01, eff);
  next.cashUsdCents += usdCents;
  const avg = pos.avgCost01 == null ? price01 : Number(pos.avgCost01);
  const costBasis = usdCentsForTrade(avg, eff);
  next.realizedPnlUsdCents += usdCents - costBasis;
  pos.shares = roundPositionShares(Math.max(0, prevShares - eff));
  if (pos.shares < MIN_SELL_SHARES) {
    pos.shares = 0;
    pos.avgCost01 = null;
  }

  savePaperAccount(next);
  return { ok: true, account: next, fill: { token, side: args.side, price01: clamp01(price01), shares: eff, usdCents } };
}

export function markToMarket(args: { account: PaperAccount; tokenId: string; mid01: number | null }): {
  equityUsdCents: number;
  unrealizedPnlUsdCents: number;
  realizedPnlUsdCents: number;
  cashUsdCents: number;
} {
  const pos = getPaperPosition(args.account, args.tokenId);
  const mid = args.mid01 != null && Number.isFinite(args.mid01) ? clamp01(args.mid01) : null;
  const value = mid == null ? 0 : usdCentsForTrade(mid, pos.shares);
  const avg = pos.avgCost01 == null ? mid : pos.avgCost01;
  const cost = avg == null ? 0 : usdCentsForTrade(avg, pos.shares);
  return {
    cashUsdCents: args.account.cashUsdCents,
    equityUsdCents: args.account.cashUsdCents + value,
    unrealizedPnlUsdCents: value - cost,
    realizedPnlUsdCents: args.account.realizedPnlUsdCents,
  };
}

