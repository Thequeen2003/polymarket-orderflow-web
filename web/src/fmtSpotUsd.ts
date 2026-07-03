/** Consistent USD formatting for underlying spot / PTB — always 2 decimal places. */

export function fmtSpotUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtSpotUsdSigned(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Chart Y-axis labels — same precision as PTB pill (no k/M shorthand). */
export function fmtSpotUsdAxis(n: number): string {
  return fmtSpotUsd(n);
}
