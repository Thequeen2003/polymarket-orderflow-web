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

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function usdCentsForTrade(price01: number, shares: number): number {
  // USD cents = price * shares * 100
  return Math.round(clamp01(price01) * shares * 100);
}

export function freshPaperAccount(now = Date.now()): PaperAccount {
  return {
    cashUsdCents: STARTING_CASH_USD_CENTS,
    realizedPnlUsdCents: 0,
    positionsByToken: {},
    updatedAt: now,
  };
}

export function getPaperPosition(a: PaperAccount, tokenId: string): PaperPosition {
  const t = String(tokenId ?? '').trim();
  if (!t) return { shares: 0, avgCost01: null };
  const p = a.positionsByToken[t];
  if (!p) return { shares: 0, avgCost01: null };
  const rawShares = Number.isFinite(Number(p.shares)) ? Math.max(0, Number(p.shares)) : 0;
  return {
    shares: roundPositionShares(rawShares),
    avgCost01:
      p.avgCost01 == null
        ? null
        : Number.isFinite(Number(p.avgCost01))
          ? Math.max(0, Math.min(1, Number(p.avgCost01)))
          : null,
  };
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

export function undoPaperFilledBuy(args: {
  account: PaperAccount;
  tokenId: string;
  shares: number;
  price01: number;
  usdCents: number;
  now?: number;
}): { ok: true; account: PaperAccount } | { ok: false; error: string } {
  const token = String(args.tokenId ?? '').trim();
  if (!token) return { ok: false, error: 'missing_token' };
  const shares = Number(args.shares);
  const price01 = Number(args.price01);
  const usdCents = Math.round(Number(args.usdCents));
  if (!Number.isFinite(shares) || shares <= 0) return { ok: false, error: 'invalid_shares' };
  if (!Number.isFinite(price01) || price01 <= 0 || price01 >= 1) return { ok: false, error: 'invalid_price' };
  if (!Number.isFinite(usdCents) || usdCents <= 0) return { ok: false, error: 'invalid_usd' };

  const next: PaperAccount = JSON.parse(JSON.stringify(args.account)) as PaperAccount;
  next.updatedAt = args.now ?? Date.now();
  if (!next.positionsByToken) next.positionsByToken = {};
  if (!next.positionsByToken[token]) next.positionsByToken[token] = { shares: 0, avgCost01: null };
  const pos = next.positionsByToken[token];

  const prevShares = roundPositionShares(Number(pos.shares) || 0);
  if (prevShares + 1e-9 < shares) {
    return { ok: false, error: `Cannot undo: position only ${prevShares.toFixed(6)}sh but undo needs ${shares.toFixed(6)}sh.` };
  }

  // Refund cash and subtract shares. Recompute avg cost as if removing a lot at `price01`.
  next.cashUsdCents += usdCents;
  const remainingShares = roundPositionShares(Math.max(0, prevShares - shares));
  if (remainingShares < MIN_SELL_SHARES) {
    pos.shares = 0;
    pos.avgCost01 = null;
    return { ok: true, account: next };
  }

  const prevAvg = pos.avgCost01 == null ? price01 : Number(pos.avgCost01);
  const numer = prevAvg * prevShares - clamp01(price01) * shares;
  const nextAvg = clamp01(numer / Math.max(1e-9, remainingShares));
  pos.shares = remainingShares;
  pos.avgCost01 = nextAvg;
  return { ok: true, account: next };
}

