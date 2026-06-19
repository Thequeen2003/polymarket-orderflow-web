import type { SportsLeagueId } from './sportsLeagues';

const STORAGE_KEY = 'pm:sports-shortcut-cache:v1';
const STALE_OK_MS = 6 * 60 * 60_000;

export type CachedSportsShortcut = {
  slug: string;
  league: string;
  question: string | null;
  gameStartTime: string | null;
  market?: unknown;
};

type CacheRow = { at: number; league: string; data: CachedSportsShortcut };

function readAll(): CacheRow[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (row): row is CacheRow =>
        row != null &&
        typeof row === 'object' &&
        typeof (row as CacheRow).at === 'number' &&
        typeof (row as CacheRow).league === 'string' &&
        (row as CacheRow).data != null,
    );
  } catch {
    return [];
  }
}

function writeAll(rows: CacheRow[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows.slice(0, 32)));
  } catch {
    /* ignore */
  }
}

export function readSportsShortcutCache(league: SportsLeagueId, maxAgeMs = STALE_OK_MS): CachedSportsShortcut | null {
  const row = readAll().find((r) => r.league === league);
  if (!row) return null;
  if (Date.now() - row.at > maxAgeMs) return null;
  return row.data;
}

export function writeSportsShortcutCache(league: SportsLeagueId, data: CachedSportsShortcut): void {
  const next = readAll().filter((r) => r.league !== league);
  next.unshift({ at: Date.now(), league, data });
  writeAll(next);
}
