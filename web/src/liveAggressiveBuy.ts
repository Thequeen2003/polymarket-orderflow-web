/**
 * Live touch buys: pay through the book up to a slipped ceiling (market-style).
 */

import { roundPrice01, roundUsd2 } from './tradingRound';

/** Limit ceiling for a market-style buy — matches API Bullpen slip cushion. */
export function aggressiveBuyPrice01(bestAsk: number, tick = 0.01): number {
  if (!Number.isFinite(bestAsk) || bestAsk <= 0 || bestAsk >= 1) return bestAsk;
  const maxP = Math.min(0.99, 1 - tick);
  const cushion = Math.max(tick * 22, 0.012, bestAsk * 0.025);
  const target = Math.min(maxP, bestAsk + cushion);
  let out = Math.ceil((target + 1e-12) / tick) * tick;
  out = Math.min(maxP, Math.max(bestAsk, out));
  if (out <= bestAsk + 1e-12 && out + tick <= maxP + 1e-12) out = Math.min(maxP, out + tick);
  return roundPrice01(out);
}

/** Leave headroom so pUSD balance / allowance rounding does not reject the order. */
export function safeMarketBuyUsd(rawUsd: number): number {
  if (!Number.isFinite(rawUsd) || rawUsd <= 0) return 0;
  const trimmed = roundUsd2(Math.floor(rawUsd * 100 * 0.995) / 100);
  if (trimmed >= 1) return trimmed;
  return rawUsd >= 1 ? 1 : roundUsd2(rawUsd);
}

export function marketBuyUsdFromIntent(args: {
  unit: 'dollars' | 'shares';
  dollars: number;
  shares: number;
  refAsk01: number;
}): number {
  if (args.unit === 'dollars') return safeMarketBuyUsd(args.dollars);
  const px = aggressiveBuyPrice01(args.refAsk01);
  if (!(px > 0)) return 0;
  return safeMarketBuyUsd(args.shares * px);
}
