import { notifyPaperAccountUpdated } from './paperAccountSync';
import { inferPaperGammaSettlement } from './paperMarketSettlement';
import { appendTradeHistory } from './tradeHistory';
import {
  clearPaperPositionsForTokens,
  refundPaperPositionsForTokens,
  freshPaperAccount,
  getPaperPosition,
  markToMarket,
  paperExpireResolvedLoser,
  paperRedeemResolvedWinner,
  paperTrade as paperTradeCore,
  undoPaperFilledBuy as undoPaperFilledBuyCore,
  type PaperAccount,
  type PaperPosition,
  type PaperTradeResult,
  type PaperTradeSide,
} from './paperTradingCore';

export type { PaperAccount, PaperPosition, PaperTradeResult, PaperTradeSide };
export { clearPaperPositionsForTokens, freshPaperAccount, getPaperPosition, markToMarket };

export function resetPaperPositionsForTokens(tokenIds: string[]): PaperAccount {
  const next = clearPaperPositionsForTokens(loadPaperAccount(), tokenIds);
  savePaperAccount(next);
  notifyPaperAccountUpdated();
  return next;
}

/** Sell Up/Down paper legs back to practice cash (Signals “I didn’t buy — refund”). */
export function refundPaperPositionsForMarket(
  tokenIds: string[],
  exitPrice01ByToken?: Record<string, number | null | undefined>,
): PaperAccount {
  const next = refundPaperPositionsForTokens(loadPaperAccount(), tokenIds, exitPrice01ByToken);
  savePaperAccount(next);
  notifyPaperAccountUpdated();
  return next;
}

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
  notifyPaperAccountUpdated();
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

const SETTLEMENT_LEDGER_KEY = 'pmof.paperSettlementLedger.v1';

function loadSettlementLedger(): Record<string, string[]> {
  try {
    const raw = window.localStorage.getItem(SETTLEMENT_LEDGER_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== 'object') return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.map(String);
    }
    return out;
  } catch {
    return {};
  }
}

function saveSettlementLedger(rows: Record<string, string[]>): void {
  try {
    window.localStorage.setItem(SETTLEMENT_LEDGER_KEY, JSON.stringify(rows));
  } catch {
    /* ignore */
  }
}

function settlementLedgerHas(marketKey: string, tokenId: string): boolean {
  const mk = String(marketKey ?? '').trim();
  const tk = String(tokenId ?? '').trim();
  if (!mk || !tk) return false;
  const L = loadSettlementLedger();
  return (L[mk] ?? []).includes(tk);
}

function settlementLedgerMark(marketKey: string, tokenId: string): void {
  const mk = String(marketKey ?? '').trim();
  const tk = String(tokenId ?? '').trim();
  if (!mk || !tk) return;
  const L = loadSettlementLedger();
  const prev = new Set(L[mk] ?? []);
  if (prev.has(tk)) return;
  prev.add(tk);
  L[mk] = [...prev];
  saveSettlementLedger(L);
}

/** Auto-settle practice positions when Gamma marks the market closed with decisive outcome prices ($1 / $0). */
export function applyPaperSettlementForLoadedMarket(args: {
  market: unknown | null;
  slug: string;
  marketTitle?: string;
}): void {
  try {
    if (typeof window === 'undefined') return;
    const plan = inferPaperGammaSettlement(args.market, args.slug);
    if (!plan) return;

    let account = loadPaperAccount();
    const title = String(args.marketTitle ?? '').trim().slice(0, 800);
    const slugTrim = String(args.slug ?? '').trim();
    let dirty = false;

    const MIN_SH = 1e-4;

    const settleWinner = (tokenId: string, label: string) => {
      const tk = tokenId.trim();
      if (!tk || settlementLedgerHas(plan.marketKey, tk)) return;
      const pos = getPaperPosition(account, tk);
      if (pos.shares < MIN_SH) {
        settlementLedgerMark(plan.marketKey, tk);
        return;
      }
      const r = paperRedeemResolvedWinner({ account, tokenId: tk });
      if (!r.ok) return;
      account = r.account;
      dirty = true;
      settlementLedgerMark(plan.marketKey, tk);
      if (r.shares >= MIN_SH && r.payoutUsdCents > 0) {
        appendTradeHistory({
          mode: 'paper',
          exec: 'settlement',
          side: 'sell',
          token: tk,
          label: label.slice(0, 120),
          price01: 1,
          fillAvgPrice01: 1,
          quotedPrice01: null,
          shares: r.shares,
          requestedShares: r.shares,
          remainingShares: 0,
          usdCents: r.payoutUsdCents,
          status: 'filled',
          marketSlug: slugTrim || undefined,
          marketTitle: title || undefined,
          auditNote: 'Paper settlement · resolved winner · $1/sh @ $1',
        });
      }
    };

    const settleLoser = (tokenId: string, label: string) => {
      const tk = tokenId.trim();
      if (!tk || settlementLedgerHas(plan.marketKey, tk)) return;
      const pos = getPaperPosition(account, tk);
      if (pos.shares < MIN_SH) {
        settlementLedgerMark(plan.marketKey, tk);
        return;
      }
      const r = paperExpireResolvedLoser({ account, tokenId: tk });
      if (!r.ok) {
        if (r.error === 'no_position') settlementLedgerMark(plan.marketKey, tk);
        return;
      }
      account = r.account;
      dirty = true;
      settlementLedgerMark(plan.marketKey, tk);
      if (r.shares >= MIN_SH) {
        appendTradeHistory({
          mode: 'paper',
          exec: 'settlement',
          side: 'sell',
          token: tk,
          label: label.slice(0, 120),
          price01: 0,
          fillAvgPrice01: 0,
          quotedPrice01: null,
          shares: r.shares,
          requestedShares: r.shares,
          remainingShares: 0,
          usdCents: 0,
          status: 'filled',
          marketSlug: slugTrim || undefined,
          marketTitle: title || undefined,
          auditNote: 'Paper settlement · losing outcome · expired @ $0',
        });
      }
    };

    for (const w of plan.winners) settleWinner(w.tokenId, w.label);
    for (const l of plan.losers) settleLoser(l.tokenId, l.label);

    if (dirty) {
      savePaperAccount(account);
      notifyPaperAccountUpdated();
      const ids = [...plan.winners.map((w) => w.tokenId), ...plan.losers.map((l) => l.tokenId)];
      cancelPaperOrdersForTokenIds(ids);
    }
  } catch {
    /* ignore */
  }
}

/** Cancel resting paper orders tied to resolved outcome tokens (avoid zombie limits after settlement). */
export function cancelPaperOrdersForTokenIds(tokenIds: string[]): void {
  const want = new Set(tokenIds.map((t) => String(t ?? '').trim()).filter(Boolean));
  if (!want.size) return;
  const orders = loadPaperOrders();
  savePaperOrders(orders.filter((o) => !want.has(String(o.tokenId ?? '').trim())));
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

