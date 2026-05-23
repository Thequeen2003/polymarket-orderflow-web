/** Polymarket / Bullpen price ticks — most markets use 0.01 (2 decimal places in 0–1 space). */

export const DEFAULT_POLYMARKET_TICK = 0.01;

export function decimalPlacesForTick(tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return 2;
  const dp = Math.round(-Math.log10(tickSize));
  return Math.max(0, Math.min(6, dp));
}

/** Snap a 0–1 price to the nearest valid tick (e.g. 0.545 → 0.55 at tick 0.01). */
export function roundPriceToTick(price: number, tickSize = DEFAULT_POLYMARKET_TICK): number {
  if (!Number.isFinite(price) || price <= 0) return price;
  const dp = decimalPlacesForTick(tickSize);
  const ticks = Math.round(price / tickSize);
  return Number((ticks * tickSize).toFixed(dp));
}

/** Bullpen CLI rejects extra decimals — always format limit prices with tick precision. */
export function formatBullpenPriceArg(price: number, tickSize = DEFAULT_POLYMARKET_TICK): string {
  return roundPriceToTick(price, tickSize).toFixed(decimalPlacesForTick(tickSize));
}
