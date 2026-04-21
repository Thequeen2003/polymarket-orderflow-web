export type PaperTradeSide = 'buy' | 'sell';

export type PaperPosition = {
  shares: number;
  avgCost01: number | null; // probability-like price (0..1)
};

export type PaperAccount = {
  cashUsdCents: number;
  realizedPnlUsdCents: number;
  positionsByToken: Record<string, PaperPosition>;
  updatedAt: number;
};

const STORAGE_KEY = 'pmof.paperAccount.v1';
const STARTING_CASH_USD_CENTS = 5000 * 100;

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
  return {
    shares: Number.isFinite(Number(p.shares)) ? Math.max(0, Number(p.shares)) : 0,
    avgCost01: p.avgCost01 == null ? null : Number.isFinite(Number(p.avgCost01)) ? Math.max(0, Math.min(1, Number(p.avgCost01))) : null,
  };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function usdCentsForTrade(price01: number, shares: number): number {
  // USD cents = price * shares * 100
  return Math.round(clamp01(price01) * shares * 100);
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

  const usdCents = usdCentsForTrade(price01, shares);

  if (args.side === 'buy') {
    if (usdCents > next.cashUsdCents) return { ok: false, error: 'insufficient_cash' };
    next.cashUsdCents -= usdCents;
    const prevShares = Number(pos.shares) || 0;
    const prevAvg = pos.avgCost01 == null ? price01 : Number(pos.avgCost01);
    const nextShares = prevShares + shares;
    const nextAvg = (prevAvg * prevShares + price01 * shares) / Math.max(1e-9, nextShares);
    pos.shares = nextShares;
    pos.avgCost01 = clamp01(nextAvg);
  } else {
    const prevShares = Number(pos.shares) || 0;
    if (shares > prevShares) return { ok: false, error: 'insufficient_shares' };
    next.cashUsdCents += usdCents;
    const avg = pos.avgCost01 == null ? price01 : Number(pos.avgCost01);
    const costBasis = usdCentsForTrade(avg, shares);
    next.realizedPnlUsdCents += usdCents - costBasis;
    pos.shares = Math.max(0, prevShares - shares);
    if (pos.shares === 0) pos.avgCost01 = null;
  }

  savePaperAccount(next);
  return { ok: true, account: next, fill: { token, side: args.side, price01: clamp01(price01), shares, usdCents } };
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

