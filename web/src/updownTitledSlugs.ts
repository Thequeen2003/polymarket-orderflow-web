import type { UpdownShortcutAsset } from './lib/api';
import { bucketFloorNoonEtUnixSec } from './updownBucketEt';

const ASSET_LONG: Record<UpdownShortcutAsset, string> = {
  btc: 'bitcoin',
  eth: 'ethereum',
  sol: 'solana',
  hype: 'hyperliquid',
};

function etParts(now = new Date()): { month: string; day: number; year: number; hourEt: string } {
  const fmtMonth = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long' });
  const fmtDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', day: 'numeric' });
  const fmtYear = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric' });
  const fmtHour = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: true,
  });
  const month = fmtMonth.format(now).toLowerCase();
  const day = Number(fmtDay.format(now));
  const year = Number(fmtYear.format(now));
  const hourEt = fmtHour.format(now).toLowerCase().replace(/\s/g, '');
  return { month, day, year, hourEt };
}

/** Client fallback when shortcut API is down — matches Polymarket titled hourly slug. */
export function buildTitledHourlySlug(asset: UpdownShortcutAsset, now = new Date()): string {
  return buildTitledHourlySlugFromBucketSec(asset, Math.floor(now.getTime() / 1000));
}

/** Polymarket titled hourly slug for a bucket start (unix sec, ET hour). */
export function buildTitledHourlySlugFromBucketSec(asset: UpdownShortcutAsset, bucketStartSec: number): string {
  const longName = ASSET_LONG[asset];
  const { month, day, year, hourEt } = etParts(new Date(bucketStartSec * 1000));
  return `${longName}-up-or-down-${month}-${day}-${year}-${hourEt}-et`;
}

/** Client fallback — live Polymarket daily slug (+ optional day offset from live window). */
export function buildTitledDailySlug(asset: UpdownShortcutAsset, dayOffset = 0, now = new Date()): string {
  const nowSec = Math.floor(now.getTime() / 1000);
  const liveBucket = bucketFloorNoonEtUnixSec(nowSec);
  return buildTitledDailySlugFromBucketSec(asset, liveBucket + dayOffset * 86_400);
}

/** Polymarket titled daily slug for a noon→noon bucket start (title uses resolution day at bucket end). */
export function buildTitledDailySlugFromBucketSec(asset: UpdownShortcutAsset, bucketStartSec: number): string {
  const longName = ASSET_LONG[asset];
  const { month, day, year } = etParts(new Date((bucketStartSec + 86_400) * 1000));
  return `${longName}-up-or-down-on-${month}-${day}-${year}`;
}
