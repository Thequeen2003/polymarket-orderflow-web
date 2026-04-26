import type { UpdownInterval, UpdownShortcutAsset } from './lib/api';

export type ParsedUpdownSlug = {
  asset: string;
  ts: number;
  interval: UpdownInterval;
  stepSec: number;
};

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
