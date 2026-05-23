/**
 * Operator-facing prices in whole cents only (62¢, not 62.0¢ or 84.5¢).
 * Internal 0..1 math can stay precise; display and bracket fields round here.
 */

export function clampPrice01(x: number): number {
  return Math.max(0.01, Math.min(0.99, x));
}

export function price01ToWholeCents(price01: number): number {
  return Math.round(clampPrice01(price01) * 100);
}

export function roundPrice01ToCent(price01: number): number {
  return price01ToWholeCents(price01) / 100;
}

export function formatCentsFrom01(price01: number): string {
  return String(price01ToWholeCents(price01));
}

export function formatCentsLabelFrom01(price01: number): string {
  return `${formatCentsFrom01(price01)}¢`;
}

export function formatCentsFromNumber(cents: number): string {
  if (!Number.isFinite(cents)) return '';
  return String(Math.round(cents));
}
