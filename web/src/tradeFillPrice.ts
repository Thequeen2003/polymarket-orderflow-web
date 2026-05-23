import { rowShowsExchangeFill } from './liveTradeTruth';
import type { TradeHistoryRow } from './tradeHistory';
import { filledSharesFromRow } from './tradeHistoryDisplay';
import { roundPrice01 } from './tradingRound';

/** Normalize CLOB/Bullpen prices (0–1 or 1–100 ¢) to 0..1. */
export function normalizePrice01(raw: unknown): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(String(raw).trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n <= 1) return roundPrice01(n);
  if (n <= 100) return roundPrice01(n / 100);
  return null;
}

/** Actual execution VWAP only — never limit, quote, or mid. */
export function fillPrice01FromRow(row: Pick<TradeHistoryRow, 'fillAvgPrice01'>): number | null {
  return normalizePrice01(row.fillAvgPrice01);
}

export function limitPrice01FromRow(
  row: Pick<TradeHistoryRow, 'submittedPrice01' | 'intendedPrice01'>,
): number | null {
  return normalizePrice01(row.submittedPrice01) ?? normalizePrice01(row.intendedPrice01);
}

export function formatFillCents(px01: number | null, digits = 2): string {
  if (px01 == null || !(px01 > 0) || px01 >= 1) return '—';
  return `${(px01 * 100).toFixed(digits)}¢`;
}

/** One-decimal ¢ for desk brackets / sell banners (matches card TP/SL). */
export function fillCentsFrom01(fill01: number): number {
  return Math.round(fill01 * 1000) / 10;
}

export type ConfirmedExchangeFill = {
  shares: number;
  fill01: number;
  fillCents: number;
};

/** Authoritative VWAP + filled size from a reconciled history row (never limit/quote). */
export function confirmedExchangeFillFromRow(row: TradeHistoryRow | undefined): ConfirmedExchangeFill | null {
  if (!row || !rowShowsExchangeFill(row)) return null;
  const fill01 = fillPrice01FromRow(row);
  if (fill01 == null) return null;
  const shares = filledSharesFromRow(row);
  if (!(shares > 0)) return null;
  return { shares, fill01, fillCents: fillCentsFrom01(fill01) };
}

/** Keep legacy `price01` aligned with exchange VWAP when a fill is confirmed. */
export function mirrorFillPriceOnRow(
  patch: Partial<Pick<TradeHistoryRow, 'fillAvgPrice01' | 'price01' | 'usdCents' | 'shares'>>,
): Partial<Pick<TradeHistoryRow, 'fillAvgPrice01' | 'price01' | 'usdCents' | 'shares'>> {
  const px = patch.fillAvgPrice01 != null ? normalizePrice01(patch.fillAvgPrice01) : null;
  if (px == null) return patch;
  const sh = patch.shares != null && patch.shares > 0 ? patch.shares : null;
  return {
    ...patch,
    fillAvgPrice01: px,
    price01: px,
    usdCents: sh != null ? Math.abs(Math.round(px * sh * 100)) : patch.usdCents,
  };
}
