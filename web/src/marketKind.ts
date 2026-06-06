import { parseUpdownSlug } from './sixPackUpdownSlugs';

export type MarketKind = 'crypto_updown' | 'sports_binary' | 'generic_binary';

const SPORTS_SLUG_PREFIX =
  /^(mlb|nba|nfl|nhl|epl|ucl|mls|cfb|cbb|wnba|atp|wta|ufc|f1|soccer|ncaab|ncaaf|mma|cs2|lol|dota2|valorant)-/i;

function marketRecord(market: unknown | null): Record<string, unknown> | null {
  if (!market || typeof market !== 'object') return null;
  return market as Record<string, unknown>;
}

/** Classify slug for Signals desk routing (PTB+spot vs book-only). */
export function inferMarketKind(slug: string | null | undefined, market?: unknown | null): MarketKind {
  const s = slug?.trim().toLowerCase() ?? '';
  if (s && parseUpdownSlug(s)) return 'crypto_updown';
  if (SPORTS_SLUG_PREFIX.test(s)) return 'sports_binary';
  const o = marketRecord(market);
  if (o) {
    if (typeof o.sport === 'string' && o.sport.trim()) return 'sports_binary';
    if (typeof o.gameStartTime === 'string' && o.gameStartTime.trim()) return 'sports_binary';
    const events = o.events;
    if (Array.isArray(events) && events.length > 0) {
      const ev0 = events[0];
      if (ev0 && typeof ev0 === 'object' && typeof (ev0 as Record<string, unknown>).ticker === 'string') {
        const ticker = String((ev0 as Record<string, unknown>).ticker).toLowerCase();
        if (SPORTS_SLUG_PREFIX.test(ticker)) return 'sports_binary';
      }
    }
  }
  return 'generic_binary';
}

export function marketUsesPtbSpotDesk(kind: MarketKind): boolean {
  return kind === 'crypto_updown';
}

export function marketKindLabel(kind: MarketKind): string {
  if (kind === 'crypto_updown') return 'Crypto up/down';
  if (kind === 'sports_binary') return 'Live sports';
  return 'Binary market';
}
