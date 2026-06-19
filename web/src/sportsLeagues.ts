/** Polymarket-style sports league shortcuts (mirrors common slug prefixes). */
export const SPORTS_LEAGUE_CHIPS = [
  { id: 'mlb', label: 'MLB' },
  { id: 'nba', label: 'NBA' },
  { id: 'nfl', label: 'NFL' },
  { id: 'nhl', label: 'NHL' },
  { id: 'epl', label: 'EPL' },
  { id: 'ucl', label: 'UCL' },
  { id: 'mls', label: 'MLS' },
  { id: 'cfb', label: 'CFB' },
  { id: 'cbb', label: 'CBB' },
  { id: 'wnba', label: 'WNBA' },
  { id: 'ufc', label: 'UFC' },
  { id: 'atp', label: 'ATP' },
  { id: 'wta', label: 'WTA' },
] as const;

export type SportsLeagueId = (typeof SPORTS_LEAGUE_CHIPS)[number]['id'];

export function sportsLeagueLabel(id: string): string {
  return SPORTS_LEAGUE_CHIPS.find((c) => c.id === id)?.label ?? id.toUpperCase();
}

export function inferSportsLeagueFromSlug(slug: string | null | undefined): SportsLeagueId | null {
  const s = slug?.trim().toLowerCase() ?? '';
  const m = s.match(/^([a-z0-9]+)-/);
  const id = m?.[1];
  if (!id) return null;
  return SPORTS_LEAGUE_CHIPS.some((c) => c.id === id) ? (id as SportsLeagueId) : null;
}
