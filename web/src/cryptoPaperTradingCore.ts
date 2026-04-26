export type CryptoTradeSide = 'buy' | 'sell';

export type CryptoPosition = {
  /** Base asset quantity (e.g. BTC). */
  qty: number;
  /** Average cost in USD per 1 base unit. */
  avgCostUsd: number | null;
};

export type CryptoPaperAccount = {
  cashUsdCents: number;
  realizedPnlUsdCents: number;
  positionsBySymbol: Record<string, CryptoPosition>;
  updatedAt: number;
};

const STARTING_CASH_USD_CENTS = 5_000 * 100;

/** BTC-size lots need more precision than Polymarket “shares”. */
const QTY_DECIMALS = 8;
const QTY_SCALE = 10 ** QTY_DECIMALS;
const MIN_SELL_QTY = 1e-8;

function roundQty(x: number): number {
  const y = Math.round(x * QTY_SCALE) / QTY_SCALE;
  return Math.abs(y) < 1 / QTY_SCALE ? 0 : y;
}

function usdCentsForTrade(priceUsd: number, qty: number): number {
  return Math.round(priceUsd * qty * 100);
}

function clampPriceUsd(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  return Math.max(0, x);
}

export function freshCryptoPaperAccount(now = Date.now()): CryptoPaperAccount {
  return {
    cashUsdCents: STARTING_CASH_USD_CENTS,
    realizedPnlUsdCents: 0,
    positionsBySymbol: {},
    updatedAt: now,
  };
}

export function getCryptoPaperPosition(a: CryptoPaperAccount, symbol: string): CryptoPosition {
  const s = String(symbol ?? '').trim().toUpperCase();
  if (!s) return { qty: 0, avgCostUsd: null };
  const p = a.positionsBySymbol[s];
  if (!p) return { qty: 0, avgCostUsd: null };
  const rawQty = Number.isFinite(Number(p.qty)) ? Math.max(0, Number(p.qty)) : 0;
  const avg =
    p.avgCostUsd == null
      ? null
      : Number.isFinite(Number(p.avgCostUsd))
        ? Math.max(0, Number(p.avgCostUsd))
        : null;
  return { qty: roundQty(rawQty), avgCostUsd: avg };
}

export type CryptoPaperTradeResult =
  | { ok: true; account: CryptoPaperAccount; fill: { symbol: string; side: CryptoTradeSide; priceUsd: number; qty: number; usdCents: number } }
  | { ok: false; error: string };

export function cryptoPaperTrade(args: {
  account: CryptoPaperAccount;
  symbol: string;
  side: CryptoTradeSide;
  /** Base asset quantity (BTC) */
  qty: number;
  /** Executed price in USD */
  priceUsd: number | null;
  now?: number;
}): CryptoPaperTradeResult {
  const symbol = String(args.symbol ?? '').trim().toUpperCase();
  if (!symbol) return { ok: false, error: 'missing_symbol' };

  const qty = Number(args.qty);
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: 'invalid_qty' };

  const priceUsd = args.priceUsd == null ? null : clampPriceUsd(Number(args.priceUsd));
  if (priceUsd == null || !Number.isFinite(priceUsd) || priceUsd <= 0) return { ok: false, error: 'invalid_price' };

  const next: CryptoPaperAccount = JSON.parse(JSON.stringify(args.account)) as CryptoPaperAccount;
  next.updatedAt = args.now ?? Date.now();
  if (!next.positionsBySymbol) next.positionsBySymbol = {};
  if (!next.positionsBySymbol[symbol]) next.positionsBySymbol[symbol] = { qty: 0, avgCostUsd: null };
  const pos = next.positionsBySymbol[symbol]!;

  if (args.side === 'buy') {
    const usdCents = usdCentsForTrade(priceUsd, qty);
    if (usdCents > next.cashUsdCents) return { ok: false, error: 'insufficient_cash' };
    next.cashUsdCents -= usdCents;
    const prevQty = roundQty(Number(pos.qty) || 0);
    const prevAvg = pos.avgCostUsd == null ? priceUsd : Number(pos.avgCostUsd);
    const nextQty = roundQty(prevQty + qty);
    const nextAvg = (prevAvg * prevQty + priceUsd * qty) / Math.max(1e-12, nextQty);
    pos.qty = nextQty;
    pos.avgCostUsd = Math.max(0, nextAvg);
    return { ok: true, account: next, fill: { symbol, side: args.side, priceUsd, qty, usdCents } };
  }

  const prevQty = roundQty(Number(pos.qty) || 0);
  const eff = roundQty(Math.min(qty, prevQty));
  if (!Number.isFinite(eff) || eff < MIN_SELL_QTY) return { ok: false, error: 'Nothing to sell (position is flat or below minimum size).' };

  const usdCents = usdCentsForTrade(priceUsd, eff);
  next.cashUsdCents += usdCents;
  const avg = pos.avgCostUsd == null ? priceUsd : Number(pos.avgCostUsd);
  const costBasis = usdCentsForTrade(avg, eff);
  next.realizedPnlUsdCents += usdCents - costBasis;
  pos.qty = roundQty(Math.max(0, prevQty - eff));
  if (pos.qty < MIN_SELL_QTY) {
    pos.qty = 0;
    pos.avgCostUsd = null;
  }
  return { ok: true, account: next, fill: { symbol, side: args.side, priceUsd, qty: eff, usdCents } };
}

export function cryptoMarkToMarket(args: { account: CryptoPaperAccount; symbol: string; midUsd: number | null }): {
  equityUsdCents: number;
  unrealizedPnlUsdCents: number;
  realizedPnlUsdCents: number;
  cashUsdCents: number;
  posQty: number;
  posAvgUsd: number | null;
} {
  const pos = getCryptoPaperPosition(args.account, args.symbol);
  const midUsd = args.midUsd != null && Number.isFinite(args.midUsd) ? clampPriceUsd(args.midUsd) : null;
  const value = midUsd == null ? 0 : usdCentsForTrade(midUsd, pos.qty);
  const avg = pos.avgCostUsd == null ? midUsd : pos.avgCostUsd;
  const cost = avg == null ? 0 : usdCentsForTrade(avg, pos.qty);
  return {
    cashUsdCents: args.account.cashUsdCents,
    equityUsdCents: args.account.cashUsdCents + value,
    unrealizedPnlUsdCents: value - cost,
    realizedPnlUsdCents: args.account.realizedPnlUsdCents,
    posQty: pos.qty,
    posAvgUsd: pos.avgCostUsd,
  };
}

