import type { UpdownInterval, UpdownShortcutAsset } from './lib/api';
import { bucketFloorEtUnixSec } from './updownBucketEt';
import { buildTitledDailySlug, buildTitledHourlySlug } from './updownTitledSlugs';

const STORAGE_KEY = 'pm:updown-shortcut-cache:v1';
const FRESH_MS = 15 * 60_000;
const STALE_OK_MS = 6 * 60 * 60_000;

export type CachedUpdownShortcut = {
  slug: string;
  trading_slug?: string;
  market?: unknown;
  asset: string;
  interval?: string;
  window: string;
  inferred_window_start_unix?: number;
  trading_inferred_window_start_unix?: number;
  trading_inferred_end_unix?: number;
  trading_start?: string | null;
  trading_end?: string | null;
  start?: string | null;
  end?: string | null;
};

type CacheRow = { at: number; asset: string; interval: string; data: CachedUpdownShortcut };

function cacheKey(asset: string, interval: string): string {
  return `${asset.trim().toLowerCase()}:${interval.trim().toLowerCase()}`;
}

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
        typeof (row as CacheRow).asset === 'string' &&
        typeof (row as CacheRow).interval === 'string' &&
        (row as CacheRow).data != null &&
        typeof (row as CacheRow).data === 'object',
    );
  } catch {
    return [];
  }
}

function writeAll(rows: CacheRow[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows.slice(0, 24)));
  } catch {
    /* ignore quota */
  }
}

/** True when the cached shortcut window has not ended (with a short grace). */
export function isUpdownShortcutWindowOpen(data: CachedUpdownShortcut, nowMs = Date.now()): boolean {
  const endRaw = data.trading_end ?? data.end;
  if (typeof endRaw !== 'string' || !endRaw.trim()) return true;
  const endMs = Date.parse(endRaw);
  if (!Number.isFinite(endMs)) return true;
  return endMs + 120_000 > nowMs;
}

/** Only reuse preloaded Gamma JSON when it matches the slug being opened. */
export function preloadedMarketForSlug(market: unknown, slug: string): unknown | undefined {
  if (!market || typeof market !== 'object') return undefined;
  const got = String((market as Record<string, unknown>).slug ?? '').trim().toLowerCase();
  const want = slug.trim().toLowerCase();
  return got && want && got === want ? market : undefined;
}

/** Bucket start for hints — prefer trading-window metadata when desk opens prior 5m bucket. */
export function inferredBucketStartSec(data: CachedUpdownShortcut, slugToOpen: string): number | undefined {
  const tradeStart = data.trading_inferred_window_start_unix;
  if (typeof tradeStart === 'number' && Number.isFinite(tradeStart) && tradeStart > 0) {
    const tradeSlug = data.trading_slug?.trim().toLowerCase();
    if (tradeSlug && tradeSlug === slugToOpen.trim().toLowerCase()) return tradeStart;
  }
  const iw = data.inferred_window_start_unix;
  return typeof iw === 'number' && Number.isFinite(iw) && iw > 0 ? iw : undefined;
}

/** Last good shortcut response — used when API times out or stalls. */
export function readUpdownShortcutCache(
  asset: UpdownShortcutAsset,
  interval: UpdownInterval,
  maxAgeMs = STALE_OK_MS,
): CachedUpdownShortcut | null {
  const key = cacheKey(asset, interval);
  const row = readAll().find((r) => cacheKey(r.asset, r.interval) === key);
  if (!row) return null;
  if (Date.now() - row.at > maxAgeMs) return null;
  if (!isUpdownShortcutWindowOpen(row.data)) return null;
  return row.data;
}

export function writeUpdownShortcutCache(
  asset: UpdownShortcutAsset,
  interval: UpdownInterval,
  data: CachedUpdownShortcut,
): void {
  const key = cacheKey(asset, interval);
  const next = readAll().filter((r) => cacheKey(r.asset, r.interval) !== key);
  next.unshift({ at: Date.now(), asset, interval, data });
  writeAll(next);
}

export function isUpdownShortcutCacheFresh(asset: UpdownShortcutAsset, interval: UpdownInterval): boolean {
  const key = cacheKey(asset, interval);
  const row = readAll().find((r) => cacheKey(r.asset, r.interval) === key);
  return row != null && Date.now() - row.at <= FRESH_MS;
}

/** Client-only slug when the shortcut API is down — ET bucket for 4h, titled slug for 1h/1d, UTC for 5m/15m. */
export function fallbackUpdownSlug(asset: UpdownShortcutAsset, interval: UpdownInterval): string {
  if (interval === '1h') return buildTitledHourlySlug(asset);
  if (interval === '1d') return buildTitledDailySlug(asset);
  const stepSec =
    interval === '15m'
      ? 900
      : interval === '4h'
        ? 4 * 3600
        : 300;
  const nowSec = Math.floor(Date.now() / 1000);
  const ts =
    interval === '4h' ? bucketFloorEtUnixSec(stepSec, nowSec) : Math.floor(nowSec / stepSec) * stepSec;
  return `${asset}-updown-${interval}-${ts}`;
}

export function slugToOpenFromShortcut(data: CachedUpdownShortcut, interval: UpdownInterval): string {
  return data.trading_slug?.trim() || data.slug.trim() || fallbackUpdownSlug(data.asset as UpdownShortcutAsset, interval);
}
