import type { BookLevel } from './bookLevels';

export type Side = 'buy' | 'sell';

export type FillStep = { price: number; size: number; cost: number };

export type FillQuote = {
  ok: boolean;
  side: Side;
  sizeShares: number;
  avgPrice: number | null;
  worstPrice: number | null;
  filledShares: number;
  unfilledShares: number;
  notional: number | null;
  steps: FillStep[];
  reason?: string;
};

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

/** Walk the ladder and estimate fill for N shares. */
export function estimateFillForShares(params: {
  side: Side;
  shares: number;
  /** For buys use asks; for sells use bids. Must be sorted best->worse. */
  levels: BookLevel[];
  /** Optional cap on levels to consider. */
  maxLevels?: number;
}): FillQuote {
  const shares = Number(params.shares);
  if (!Number.isFinite(shares) || shares <= 0) {
    return {
      ok: false,
      side: params.side,
      sizeShares: 0,
      avgPrice: null,
      worstPrice: null,
      filledShares: 0,
      unfilledShares: 0,
      notional: null,
      steps: [],
      reason: 'bad_shares',
    };
  }
  const maxLevels = params.maxLevels ?? 18;
  const lv = (params.levels ?? []).slice(0, maxLevels).filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0);
  if (lv.length === 0) {
    return {
      ok: false,
      side: params.side,
      sizeShares: shares,
      avgPrice: null,
      worstPrice: null,
      filledShares: 0,
      unfilledShares: shares,
      notional: null,
      steps: [],
      reason: 'empty_book',
    };
  }

  let remaining = shares;
  let filled = 0;
  let cost = 0;
  const steps: FillStep[] = [];

  for (const l of lv) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, l.size);
    const c = take * l.price;
    steps.push({ price: l.price, size: take, cost: c });
    remaining -= take;
    filled += take;
    cost += c;
  }

  const avgPrice = filled > 0 ? cost / filled : null;
  const worstPrice = steps.length ? steps[steps.length - 1]!.price : null;

  return {
    ok: filled > 0,
    side: params.side,
    sizeShares: shares,
    avgPrice,
    worstPrice,
    filledShares: filled,
    unfilledShares: remaining,
    notional: filled > 0 ? cost : null,
    steps,
    reason: remaining > 0 ? 'insufficient_depth' : undefined,
  };
}

export type Net4cEstimate = {
  ok: boolean;
  reason?: string;
  entry: FillQuote;
  /** For TP we assume limit sell at entryAvg+0.04 that fills against bids at/above that price. */
  tpExit: {
    targetPrice: number | null;
    fill: FillQuote;
  };
  net: {
    /** Net profit in price units (0..1). */
    profit01: number | null;
    profitCents: number | null;
    profitUsd: number | null;
    /** How much gross move is required to net +4c under current spread/slippage. */
    requiredGrossCents: number | null;
    spreadCents: number | null;
    entrySlippageCents: number | null;
    exitSlippageCents: number | null;
  };
  flags: string[];
};

function cents(x01: number | null): number | null {
  if (x01 == null || !Number.isFinite(x01)) return null;
  return x01 * 100;
}

/** Estimate whether a buy->sell can net +4¢ given current depth. */
export function estimateNet4cLong(params: {
  /** Asks sorted best->worse */
  asks: BookLevel[];
  /** Bids sorted best->worse */
  bids: BookLevel[];
  /** Desired size in shares */
  shares: number;
  /** How many levels to consider */
  maxLevels?: number;
}): Net4cEstimate {
  const flags: string[] = [];
  const shares = params.shares;
  if (!Number.isFinite(shares) || shares <= 0) {
    return {
      ok: false,
      reason: 'bad_shares',
      entry: estimateFillForShares({ side: 'buy', shares: 0, levels: [] }),
      tpExit: { targetPrice: null, fill: estimateFillForShares({ side: 'sell', shares: 0, levels: [] }) },
      net: { profit01: null, profitCents: null, profitUsd: null, requiredGrossCents: null, spreadCents: null, entrySlippageCents: null, exitSlippageCents: null },
      flags,
    };
  }

  const entry = estimateFillForShares({ side: 'buy', shares, levels: params.asks, maxLevels: params.maxLevels });
  if (!entry.ok || entry.avgPrice == null) {
    return {
      ok: false,
      reason: entry.reason ?? 'no_entry',
      entry,
      tpExit: { targetPrice: null, fill: estimateFillForShares({ side: 'sell', shares: 0, levels: [] }) },
      net: { profit01: null, profitCents: null, profitUsd: null, requiredGrossCents: null, spreadCents: null, entrySlippageCents: null, exitSlippageCents: null },
      flags: ['NoEntry'],
    };
  }

  const bestAsk = params.asks[0]?.price ?? null;
  const bestBid = params.bids[0]?.price ?? null;
  const spread = bestAsk != null && bestBid != null && bestAsk >= bestBid ? bestAsk - bestBid : null;
  const spreadC = spread != null ? spread * 100 : null;
  if (spreadC != null && spreadC > 6) flags.push('WideSpread');

  const entrySlippage = bestAsk != null ? entry.avgPrice - bestAsk : null;
  const entrySlipC = entrySlippage != null ? entrySlippage * 100 : null;
  if (entrySlipC != null && entrySlipC > 1.0) flags.push('EntrySlippage');

  const tpTarget = clamp(entry.avgPrice + 0.04, 0.01, 0.99);

  // For a limit sell at tpTarget, you fill against bids at >= tpTarget. So filter bids down to those prices.
  const tpBids = (params.bids ?? []).filter((b) => b.price >= tpTarget);
  const exit = estimateFillForShares({ side: 'sell', shares, levels: tpBids, maxLevels: params.maxLevels });
  if (!exit.ok || exit.avgPrice == null) flags.push('NoLiquidityAtTP');

  const exitSlippage = exit.avgPrice != null ? tpTarget - exit.avgPrice : null;
  const exitSlipC = exitSlippage != null ? exitSlippage * 100 : null;
  if (exitSlipC != null && exitSlipC > 1.0) flags.push('ExitSlippage');

  const profit01 = exit.avgPrice != null ? exit.avgPrice - entry.avgPrice : null;
  const profitC = cents(profit01);
  const profitUsd = profit01 != null ? profit01 * shares : null;

  // Required gross move to net +4¢: 4¢ + spread + (entry slip + exit slip).
  const requiredGrossCents =
    spreadC != null && entrySlipC != null && exitSlipC != null ? 4 + spreadC + entrySlipC + exitSlipC : null;

  const ok = profitC != null && profitC >= 4 && exit.unfilledShares <= 1e-9;
  if (profitC != null && profitC < 4) flags.push('Below4cNet');
  if (exit.unfilledShares > 1e-9) flags.push('PartialAtTP');

  return {
    ok,
    entry,
    tpExit: { targetPrice: tpTarget, fill: exit },
    net: {
      profit01,
      profitCents: profitC,
      profitUsd,
      requiredGrossCents,
      spreadCents: spreadC,
      entrySlippageCents: entrySlipC,
      exitSlippageCents: exitSlipC,
    },
    flags,
  };
}

