import { DateTime } from 'luxon';

import { bucketFloorNoonEtUnixSec } from './updownBucketEt.js';

/** Shared helpers for Polymarket Up/Down hourly/daily titled slugs + window liveness. */

export function titledUpdownStepSecFromSlug(slug: string): number | null {
  const s = slug.trim().toLowerCase();
  if (s.includes('-up-or-down-on-')) return 86400;
  if (/-\d{1,2}(am|pm)-et$/i.test(s)) return 3600;
  return null;
}

export function titledUpdownAssetFromSlug(slug: string): 'btc' | 'eth' | 'sol' | 'hype' | null {
  const s = slug.trim().toLowerCase();
  if (s.startsWith('bitcoin-')) return 'btc';
  if (s.startsWith('ethereum-')) return 'eth';
  if (s.startsWith('solana-')) return 'sol';
  if (s.startsWith('hyperliquid-') || s.startsWith('hype-')) return 'hype';
  return null;
}

/** Window still accepting trades — Gamma `closed` is often true while `endDate` is still in the future. */
export function isUpdownWindowOpen(args: {
  active: boolean;
  closed: boolean;
  endMs: number | null;
  nowMs?: number;
}): boolean {
  const now = args.nowMs ?? Date.now();
  if (args.endMs != null && Number.isFinite(args.endMs)) {
    if (args.endMs > now) return true;
    // Brief grace after window end (settlement / book wind-down).
    if (args.endMs > now - 120_000) return args.active;
  }
  return args.active && !args.closed;
}

/** Polymarket titled hourly slug for the current ET clock hour, e.g. `bitcoin-up-or-down-may-16-2026-8pm-et`. */
export function buildTitledHourlySlug(asset: string, nowSec?: number): string {
  const dt = DateTime.fromSeconds(nowSec ?? Math.floor(Date.now() / 1000), { zone: 'America/New_York' });
  const longName =
    asset === 'btc'
      ? 'bitcoin'
      : asset === 'eth'
        ? 'ethereum'
        : asset === 'sol'
          ? 'solana'
          : asset === 'hype'
            ? 'hyperliquid'
            : asset;
  const month = dt.toFormat('MMMM').toLowerCase();
  const day = String(dt.day);
  const year = String(dt.year);
  const hourEt = dt.toFormat('ha').toLowerCase().replace(/\s/g, '');
  return `${longName}-up-or-down-${month}-${day}-${year}-${hourEt}-et`;
}

/** Unix second when the current ET hour window ends (exclusive). */
export function currentEtHourEndUnixSec(nowSec?: number): number {
  const sec = nowSec ?? Math.floor(Date.now() / 1000);
  const dt = DateTime.fromSeconds(sec, { zone: 'America/New_York' });
  return Math.floor(dt.startOf('hour').plus({ hours: 1 }).toSeconds());
}

/** Polymarket titled daily slug, e.g. `bitcoin-up-or-down-on-june-11-2026` (resolution day). */
export function buildTitledDailySlug(asset: string, dayOffset = 0, nowSec?: number): string {
  const sec = nowSec ?? Math.floor(Date.now() / 1000);
  const liveBucket = bucketFloorNoonEtUnixSec(sec);
  return buildTitledDailySlugFromBucketSec(asset, liveBucket + dayOffset * 86_400);
}

/** Titled daily slug for a noon→noon bucket start (title = ET date at bucket end). */
export function buildTitledDailySlugFromBucketSec(asset: string, bucketStartSec: number): string {
  const dt = DateTime.fromSeconds(bucketStartSec + 86_400, { zone: 'America/New_York' });
  const longName =
    asset === 'btc'
      ? 'bitcoin'
      : asset === 'eth'
        ? 'ethereum'
        : asset === 'sol'
          ? 'solana'
          : asset === 'hype'
            ? 'hyperliquid'
            : asset;
  const month = dt.toFormat('MMMM').toLowerCase();
  const day = String(dt.day);
  const year = String(dt.year);
  return `${longName}-up-or-down-on-${month}-${day}-${year}`;
}

/** Extra Gamma search strings for the current ET hour (titled `*-5pm-et` slugs). */
export function updown1hEtSearchQueries(asset: string): string[] {
  const dt = DateTime.now().setZone('America/New_York');
  const longName =
    asset === 'btc'
      ? 'bitcoin'
      : asset === 'eth'
        ? 'ethereum'
        : asset === 'sol'
          ? 'solana'
          : asset === 'hype'
            ? 'hyperliquid'
            : asset;
  const month = dt.toFormat('MMMM').toLowerCase();
  const day = String(dt.day);
  const year = String(dt.year);
  const hourEt = dt.toFormat('ha').toLowerCase().replace(/\s/g, '');
  const titled = `${longName}-up-or-down-${month}-${day}-${year}-${hourEt}-et`;
  return [titled, `${longName} up or down ${month} ${day} ${hourEt} et`, `${longName} up or down ${hourEt} et`];
}
