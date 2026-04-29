import type { UpdownInterval, UpdownShortcutAsset } from './lib/api';

export type ParsedUpdownSlug = {
  asset: string;
  ts: number;
  interval: UpdownInterval;
  stepSec: number;
};

/** When Gamma returns titled hourly/daily slugs, the app stores bucket metadata from `endDate` + shortcut API. */
export type UpdownSlugHint = {
  asset: UpdownShortcutAsset;
  interval: UpdownInterval;
  bucketStartSec: number;
};

function titledHourlyOrDailyStepSec(slug: string): 3600 | 86400 | null {
  const s = slug.trim().toLowerCase();
  if (s.includes('-up-or-down-on-')) return 86400;
  if (/-\d{1,2}(am|pm)-et$/i.test(s)) return 3600;
  return null;
}

function titledShortcutAsset(slug: string): UpdownShortcutAsset | null {
  const s = slug.trim().toLowerCase();
  if (s.startsWith('bitcoin-')) return 'btc';
  if (s.startsWith('ethereum-')) return 'eth';
  if (s.startsWith('solana-')) return 'sol';
  return null;
}

/**
 * Infer canonical-style bucket fields from Polymarket titled Up/Down markets
 * (`bitcoin-up-or-down-…-5pm-et`, `bitcoin-up-or-down-on-april-28-2026`, …) using `endDate`.
 */
export function inferUpdownHintFromMarketJson(slug: string, market: Record<string, unknown>): UpdownSlugHint | null {
  const stepSec = titledHourlyOrDailyStepSec(slug);
  const asset = titledShortcutAsset(slug);
  if (!stepSec || !asset) return null;
  const endRaw = market.endDate ?? market.end_date;
  if (typeof endRaw !== 'string') return null;
  const endMs = Date.parse(endRaw);
  if (!Number.isFinite(endMs)) return null;
  const bucketStartSec = Math.floor(endMs / 1000) - stepSec;
  const interval: UpdownInterval = stepSec === 86400 ? '1d' : '1h';
  return { asset, interval, bucketStartSec };
}

export function parseUpdownSlugWithHints(
  slug: string,
  hints?: Readonly<Record<string, UpdownSlugHint>> | null,
): ParsedUpdownSlug | null {
  const c = parseUpdownSlug(slug);
  if (c) return c;
  const h = hints?.[slug.trim().toLowerCase()];
  if (!h) return null;
  const stepSec =
    h.interval === '15m' ? 900 : h.interval === '1h' ? 3600 : h.interval === '4h' ? 4 * 3600 : h.interval === '1d' ? 86400 : 300;
  return { asset: h.asset, interval: h.interval, ts: h.bucketStartSec, stepSec };
}

export function parseUpdownSlug(slug: string): ParsedUpdownSlug | null {
  const m = slug.trim().toLowerCase().match(/^([a-z0-9]{2,10})-updown-(5m|15m|1h|4h|1d)-(\d+)$/);
  if (!m) return null;
  const asset = m[1]!;
  const interval = m[2] as UpdownInterval;
  const ts = Number(m[3]);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const stepSec = interval === '15m' ? 900 : interval === '1h' ? 3600 : interval === '4h' ? 4 * 3600 : interval === '1d' ? 24 * 3600 : 300;
  return { asset, ts, interval, stepSec };
}

export function nextUpdownSlug(slug: string, dir: -1 | 1): string | null {
  const p = parseUpdownSlug(slug);
  if (!p) return null;
  return `${p.asset}-updown-${p.interval}-${p.ts + dir * p.stepSec}`;
}

/**
 * Map live shortcut slug → slug the app trades with:
 * 15m uses the live (current) window; 5m uses the **prior** bucket (same as App Command).
 */
export function tradingSlugFromLiveShortcut(liveSlug: string, interval: UpdownInterval): string {
  if (interval !== '5m') return liveSlug;
  return nextUpdownSlug(liveSlug, -1) ?? liveSlug;
}

export type SixPackKey = 'btc-5m' | 'btc-15m' | 'eth-5m' | 'eth-15m' | 'sol-5m' | 'sol-15m';

export const SIX_PACK_ROWS: readonly { key: SixPackKey; asset: UpdownShortcutAsset; interval: UpdownInterval }[] = [
  { key: 'btc-5m', asset: 'btc', interval: '5m' },
  { key: 'btc-15m', asset: 'btc', interval: '15m' },
  { key: 'eth-5m', asset: 'eth', interval: '5m' },
  { key: 'eth-15m', asset: 'eth', interval: '15m' },
  { key: 'sol-5m', asset: 'sol', interval: '5m' },
  { key: 'sol-15m', asset: 'sol', interval: '15m' },
] as const;

export function labelForSixPackKey(key: SixPackKey): string {
  const [a, b] = key.split('-');
  return `${(a ?? '').toUpperCase()} ${b ?? ''}`;
}
