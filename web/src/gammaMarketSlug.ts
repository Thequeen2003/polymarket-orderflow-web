/** True when this object is a Gamma market row (not an event wrapper). */
function isGammaMarketRow(m: unknown): boolean {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  if (typeof o.conditionId === 'string' && o.conditionId.startsWith('0x')) return true;
  if (o.clobTokenIds != null || o.clob_token_ids != null) return true;
  if (
    typeof o.question === 'string' &&
    (typeof o.slug === 'string' || typeof o.id === 'string' || typeof o.id === 'number')
  )
    return true;
  const mk = o.markets;
  const hasNestedMarkets = Array.isArray(mk) && mk.length > 0;
  if (
    !hasNestedMarkets &&
    typeof o.slug === 'string' &&
    o.slug.trim() &&
    (typeof o.id === 'string' || typeof o.id === 'number')
  )
    return true;
  return false;
}

/** Best-effort Polymarket / Gamma market slug for Bullpen + API routing. */
export function pickMarketSlug(m: unknown): string {
  if (!m || typeof m !== 'object') return '';
  const o = m as Record<string, unknown>;
  if (!isGammaMarketRow(m)) {
    const mk = o.markets;
    if (Array.isArray(mk) && mk.length > 0) {
      const first = mk[0];
      if (first && isGammaMarketRow(first)) {
        return pickMarketSlug(first);
      }
    }
  }
  if (typeof o.slug === 'string' && o.slug.trim()) return o.slug.trim();
  if (typeof o.market_slug === 'string' && o.market_slug.trim()) return o.market_slug.trim();
  if (typeof o.id === 'string' && o.id.trim()) return o.id.trim();
  if (typeof o.id === 'number' && Number.isFinite(o.id)) return String(o.id);
  return '';
}
