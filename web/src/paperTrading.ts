import {
  freshPaperAccount,
  getPaperPosition,
  markToMarket,
  paperTrade as paperTradeCore,
  undoPaperFilledBuy as undoPaperFilledBuyCore,
  type PaperAccount,
  type PaperPosition,
  type PaperTradeResult,
  type PaperTradeSide,
} from './paperTradingCore';

export type { PaperAccount, PaperPosition, PaperTradeResult, PaperTradeSide };
export { freshPaperAccount, getPaperPosition, markToMarket };

export type PaperOrder = {
  id: string;
  tokenId: string;
  side: PaperTradeSide;
  /** Limit price (0..1) */
  limit01: number;
  shares: number;
  createdAt: number;
};

const STORAGE_KEY = 'pmof.paperAccount.v1';
const ORDERS_KEY = 'pmof.paperOrders.v1';

/** Fired after paper orders mutate (create/cancel/fill) so UI can avoid polling localStorage. */
export const PAPER_ORDERS_SYNC_EVENT = 'pmof:paper-orders-sync';

export function notifyPaperOrdersUpdated(): void {
  window.dispatchEvent(new Event(PAPER_ORDERS_SYNC_EVENT));
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

/** UI wrapper: executes trade and persists to localStorage. */
export function paperTrade(args: {
  account: PaperAccount;
  tokenId: string;
  side: PaperTradeSide;
  shares: number;
  price01: number | null;
  now?: number;
}): PaperTradeResult {
  const r = paperTradeCore(args);
  if (!r.ok) return r;
  savePaperAccount(r.account);
  return r;
}

/** UI wrapper: undoes a buy and persists to localStorage. */
export function undoPaperFilledBuy(args: {
  account: PaperAccount;
  tokenId: string;
  shares: number;
  price01: number;
  usdCents: number;
  now?: number;
}): { ok: true; account: PaperAccount } | { ok: false; error: string } {
  const r = undoPaperFilledBuyCore(args);
  if (!r.ok) return r;
  savePaperAccount(r.account);
  return r;
}

export function setPaperCashUsd(args: { account: PaperAccount; cashUsd: number; now?: number }): PaperAccount {
  const usd = Number(args.cashUsd);
  const cents = Number.isFinite(usd) ? Math.max(0, Math.round(usd * 100)) : null;
  if (cents == null) return args.account;
  const next: PaperAccount = JSON.parse(JSON.stringify(args.account)) as PaperAccount;
  next.cashUsdCents = cents;
  next.updatedAt = args.now ?? Date.now();
  savePaperAccount(next);
  return next;
}

export function resetPaperAccount(): PaperAccount {
  const next = freshPaperAccount();
  savePaperAccount(next);
  return next;
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
    notifyPaperOrdersUpdated();
  } catch {
    /* ignore */
  }
}

export function addPaperOrder(args: { tokenId: string; side: PaperTradeSide; limit01: number; shares: number; now?: number }): PaperOrder {
  const o: PaperOrder = {
    id: randomId(),
    tokenId: String(args.tokenId ?? '').trim(),
    side: args.side,
    limit01: Math.max(0, Math.min(1, args.limit01)),
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
  const mid = Math.max(0, Math.min(1, mid01));
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
    const mid = Math.max(0, Math.min(1, mid01));
    const px = o.side === 'buy' ? Math.min(mid, o.limit01) : Math.max(mid, o.limit01);
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

