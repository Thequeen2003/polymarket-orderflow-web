import { normalizeMarket, dedupeSearchRows, flattenSearchMarketRows } from './polymarket/marketNormalize.js';
import { gammaEventsBySeriesId, gammaSearchMarkets } from './polymarket/gamma.js';
import { clobHasBookCached, gammaMarketCached } from './updownCanonicalProbe.js';
import { parseClobTokenIds } from './polymarket/marketNormalize.js';

export const SPORTS_LEAGUES = [
  'mlb',
  'nba',
  'nfl',
  'nhl',
  'epl',
  'ucl',
  'mls',
  'cfb',
  'cbb',
  'wnba',
  'ufc',
  'atp',
  'wta',
] as const;

export type SportsLeague = (typeof SPORTS_LEAGUES)[number];

/** UI league chip → Polymarket `/sports` series id (stable on Gamma). */
export const LEAGUE_SERIES_ID: Record<SportsLeague, number> = {
  mlb: 3,
  nba: 10345,
  nfl: 10187,
  nhl: 10346,
  epl: 10188,
  ucl: 10204,
  mls: 10189,
  cfb: 10210,
  cbb: 10470,
  wnba: 10105,
  ufc: 10500,
  atp: 10365,
  wta: 10366,
};

const SPORTS_SLUG_PREFIX =
  /^(mlb|nba|nfl|nhl|epl|ucl|mls|cfb|cbb|wnba|atp|wta|ufc|f1|soccer|ncaab|ncaaf|mma|cs2|lol|dota2|valorant)-/i;

/** `{league}-{team}-{team}-{yyyy}-{mm}-{dd}` — Polymarket game event slug. */
export const SPORTS_GAME_SLUG =
  /^(mlb|nba|nfl|nhl|epl|ucl|mls|cfb|cbb|wnba|atp|wta|ufc)-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}$/i;

export type SportsMarketRow = {
  slug: string;
  question: string | null;
  league: string | null;
  gameStartTime: string | null;
  endDate: string | null;
  volume24hr: number;
  active: boolean;
  closed: boolean;
  market: Record<string, unknown>;
};

function marketRecord(m: unknown): Record<string, unknown> | null {
  if (!m || typeof m !== 'object') return null;
  return m as Record<string, unknown>;
}

function slugFromMarket(m: Record<string, unknown>): string {
  const slug = typeof m.slug === 'string' ? m.slug.trim() : '';
  if (slug) return slug;
  if (typeof m.id === 'string') return m.id.trim();
  if (typeof m.id === 'number' && Number.isFinite(m.id)) return String(m.id);
  return '';
}

function inferLeague(slug: string, m: Record<string, unknown>): string | null {
  const match = slug.match(/^([a-z0-9]+)-/i);
  if (match?.[1]) return match[1].toLowerCase();
  if (typeof m.sport === 'string' && m.sport.trim()) return m.sport.trim().toLowerCase();
  return null;
}

export function isSportsGameSlug(slug: string | null | undefined): boolean {
  const s = slug?.trim().toLowerCase() ?? '';
  return Boolean(s && SPORTS_GAME_SLUG.test(s));
}

export function isSportsMarketShape(m: unknown): boolean {
  const o = marketRecord(m);
  if (!o) return false;
  const slug = slugFromMarket(o).toLowerCase();
  if (slug && SPORTS_SLUG_PREFIX.test(slug)) return true;
  if (typeof o.sport === 'string' && o.sport.trim()) return true;
  if (typeof o.gameStartTime === 'string' && o.gameStartTime.trim()) return true;
  return false;
}

function isMarketOpen(m: Record<string, unknown>): boolean {
  if (m.closed === true) return false;
  if (m.active === false) return false;
  return true;
}

async function marketHasBook(m: Record<string, unknown>): Promise<boolean> {
  const tokenIds = parseClobTokenIds(m.clobTokenIds ?? m.clob_token_ids);
  const t0 = tokenIds[0];
  if (!t0) return false;
  return clobHasBookCached(t0);
}

function toSportsRow(m: Record<string, unknown>): SportsMarketRow | null {
  const slug = slugFromMarket(m);
  if (!slug) return null;
  const norm = normalizeMarket(m) as Record<string, unknown>;
  const vol = Number(norm.volume24hr ?? norm.volume ?? 0);
  return {
    slug,
    question: typeof norm.question === 'string' ? norm.question : null,
    league: inferLeague(slug, norm),
    gameStartTime: typeof norm.gameStartTime === 'string' ? norm.gameStartTime : null,
    endDate: typeof norm.endDate === 'string' ? norm.endDate : typeof norm.end_date === 'string' ? norm.end_date : null,
    volume24hr: Number.isFinite(vol) ? vol : 0,
    active: norm.active !== false,
    closed: norm.closed === true,
    market: norm,
  };
}

/** Prefer moneyline (team vs team) over spreads/totals on a game event. */
export function pickPrimaryGameMarket(
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  const eventSlug = typeof event.slug === 'string' ? event.slug.trim() : '';
  const markets = Array.isArray(event.markets) ? event.markets : [];
  const normalized = markets
    .map((m) => marketRecord(m))
    .filter((m): m is Record<string, unknown> => m != null);

  const moneyline =
    normalized.find((m) => {
      const slug = slugFromMarket(m);
      if (eventSlug && slug === eventSlug) return true;
      const kind = String(m.sportsMarketType ?? m.sports_market_type ?? '').toLowerCase();
      return kind === 'moneyline';
    }) ??
    normalized.find((m) => {
      const slug = slugFromMarket(m).toLowerCase();
      return (
        isSportsGameSlug(eventSlug) &&
        slug.startsWith(`${eventSlug.toLowerCase()}-`) === false &&
        slug === eventSlug.toLowerCase()
      );
    });

  if (moneyline) return moneyline;

  const nonProp = normalized.find((m) => {
    const slug = slugFromMarket(m).toLowerCase();
    return (
      !slug.includes('-spread-') &&
      !slug.includes('-total-') &&
      !slug.includes('-first-five-') &&
      !slug.includes('-nrfi') &&
      !slug.includes('-extra-innings')
    );
  });
  return nonProp ?? normalized[0] ?? null;
}

function rowFromGameEvent(event: Record<string, unknown>, leagueKey: string | null): SportsMarketRow | null {
  const primary = pickPrimaryGameMarket(event);
  if (!primary) return null;
  const row = toSportsRow(primary);
  if (!row) return null;
  if (leagueKey && row.league && row.league !== leagueKey) return null;
  if (!isMarketOpen(row.market)) return null;
  const eventTitle = typeof event.title === 'string' ? event.title : null;
  if (eventTitle && !row.question) row.question = eventTitle;
  const eventVol = Number(event.volume24hr ?? event.volume ?? 0);
  if (Number.isFinite(eventVol) && eventVol > row.volume24hr) row.volume24hr = eventVol;
  return row;
}

function scoreSportsRow(row: SportsMarketRow, leagueFilter?: string): number {
  let score = row.volume24hr;
  if (leagueFilter && row.league === leagueFilter) score += 50_000;
  if (row.active && !row.closed) score += 10_000;
  if (isSportsGameSlug(row.slug)) score += 200_000;
  const startMs = row.gameStartTime ? Date.parse(row.gameStartTime) : NaN;
  if (Number.isFinite(startMs)) {
    const dist = Math.abs(startMs - Date.now());
    score += Math.max(0, 150_000 - dist / 30_000);
    // Prefer games starting soon (not months away).
    if (startMs > Date.now() - 4 * 60 * 60_000 && startMs < Date.now() + 36 * 60 * 60_000) {
      score += 80_000;
    }
  }
  // Deprioritize season-long props without a game clock.
  if (!row.gameStartTime && !isSportsGameSlug(row.slug)) score -= 100_000;
  return score;
}

async function collectFromSeries(leagueKey: string): Promise<SportsMarketRow[]> {
  const seriesId = LEAGUE_SERIES_ID[leagueKey as SportsLeague];
  if (!seriesId) return [];
  try {
    const raw = await gammaEventsBySeriesId(seriesId, 40);
    const rows: SportsMarketRow[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      const ev = marketRecord(item);
      if (!ev) continue;
      const eventSlug = typeof ev.slug === 'string' ? ev.slug.trim() : '';
      if (eventSlug.includes('-first-five-') || eventSlug.includes('-spread-') || eventSlug.includes('-total-')) {
        continue;
      }
      const row = rowFromGameEvent(ev, leagueKey);
      if (!row || seen.has(row.slug)) continue;
      seen.add(row.slug);
      rows.push(row);
    }
    return rows;
  } catch {
    return [];
  }
}

async function collectSportsCandidates(league?: string): Promise<SportsMarketRow[]> {
  const leagueKey = league?.trim().toLowerCase() || null;
  const rows: SportsMarketRow[] = [];
  const seen = new Set<string>();

  if (leagueKey && leagueKey in LEAGUE_SERIES_ID) {
    for (const row of await collectFromSeries(leagueKey)) {
      if (seen.has(row.slug)) continue;
      seen.add(row.slug);
      rows.push(row);
    }
  }

  const queries = leagueKey
    ? [`${leagueKey} vs`, `${leagueKey} live`, leagueKey]
    : ['mlb vs', 'nba vs', 'nfl vs', 'nhl vs'];

  for (const q of queries) {
    try {
      const raw = await gammaSearchMarkets(q, 20, 80);
      const flat = dedupeSearchRows(flattenSearchMarketRows(raw)).map(normalizeMarket);
      for (const item of flat) {
        const o = marketRecord(item);
        if (!o || !isSportsMarketShape(o)) continue;
        const row = toSportsRow(o);
        if (!row || seen.has(row.slug)) continue;
        if (leagueKey && row.league && row.league !== leagueKey) continue;
        if (!isMarketOpen(row.market)) continue;
        seen.add(row.slug);
        rows.push(row);
      }
    } catch {
      /* try next query */
    }
  }

  return rows.sort((a, b) => scoreSportsRow(b, leagueKey ?? undefined) - scoreSportsRow(a, leagueKey ?? undefined));
}

/** Best live sports market for a league (with CLOB book when possible). */
export async function resolveSportsShortcut(league: string): Promise<SportsMarketRow | null> {
  const leagueKey = league.trim().toLowerCase();
  const candidates = await collectSportsCandidates(leagueKey);
  const gameFirst = [...candidates].sort(
    (a, b) => scoreSportsRow(b, leagueKey) - scoreSportsRow(a, leagueKey),
  );
  for (const row of gameFirst) {
    if (await marketHasBook(row.market)) return row;
  }
  return gameFirst[0] ?? null;
}

/** Live sports markets across one or all leagues. */
export async function listSportsLive(params: {
  league?: string;
  limit?: number;
}): Promise<SportsMarketRow[]> {
  const limit = Math.max(1, Math.min(40, params.limit ?? 16));
  const candidates = await collectSportsCandidates(params.league?.trim().toLowerCase());
  const out: SportsMarketRow[] = [];
  for (const row of candidates) {
    if (out.length >= limit) break;
    if (await marketHasBook(row.market)) out.push(row);
  }
  if (out.length < limit) {
    for (const row of candidates) {
      if (out.length >= limit) break;
      if (!out.some((r) => r.slug === row.slug)) out.push(row);
    }
  }
  return out.slice(0, limit);
}

/** Hydrate a sports row from slug when shortcut cache only has slug. */
export async function hydrateSportsMarket(slug: string): Promise<SportsMarketRow | null> {
  const m = await gammaMarketCached(slug.trim());
  if (!m || !isSportsMarketShape(m)) return null;
  const row = toSportsRow(m);
  if (!row) return null;
  return row;
}
