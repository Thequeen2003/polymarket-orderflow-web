/** Client-side rounding aligned with Polymarket CLOB conventions (USDC 2dp, outcome shares 4dp). */

export function roundUsd2(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

/** Floor shares so requested size never exceeds on-chain balance (matches API market sell). */
export function floorShares4(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.floor(n * 1e4 + 1e-12) / 1e4;
}

/** Display / parse balance string as human shares (4dp). */
export function roundShares4(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 1e4) / 1e4;
}

export function roundPrice01(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return n;
  return Math.round(n * 1_000_000) / 1_000_000;
}
