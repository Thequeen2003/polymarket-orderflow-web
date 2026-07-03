import type { UpdownInterval } from './lib/api';
import { updownSlugAtBucket } from './sixPackUpdownSlugs';

export type UpdownWindowPickerItem = {
  slug: string;
  label: string;
  ts: number;
  /** Steps from current bucket: 0 = live, +N = past, −N = future. */
  offset: number;
  isFuture: boolean;
  isCurrent: boolean;
};

export function updownWindowPickerCounts(interval: UpdownInterval): { past: number; future: number } {
  switch (interval) {
    case '1d':
      return { past: 14, future: 7 };
    case '4h':
      return { past: 36, future: 8 };
    case '1h':
      return { past: 48, future: 12 };
    case '15m':
      return { past: 12, future: 4 };
    default:
      return { past: 24, future: 6 };
  }
}

function formatWindowLabel(interval: UpdownInterval, ts: number, step: number, isFuture: boolean): string {
  const d = new Date(ts * 1000);
  let base: string;
  if (interval === '1d') {
    base = new Date((ts + step) * 1000).toLocaleDateString(undefined, {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
    });
  } else if (interval === '1h') {
    base = d.toLocaleString(undefined, {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
    });
  } else if (interval === '4h') {
    base = `${d.toLocaleTimeString(undefined, {
      timeZone: 'America/New_York',
      hour: 'numeric',
    })}–${new Date((ts + step) * 1000).toLocaleTimeString(undefined, {
      timeZone: 'America/New_York',
      hour: 'numeric',
    })} ET`;
  } else {
    base = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (isFuture) return `↑ ${base}`;
  return base;
}

export function buildUpdownWindowPickerItems(args: {
  asset: string;
  interval: UpdownInterval;
  bucketStartSec: number;
  stepSec: number;
  currentSlug: string;
  titled: boolean;
}): UpdownWindowPickerItem[] {
  const { asset, interval, bucketStartSec, stepSec, currentSlug, titled } = args;
  const snapped = Math.floor(bucketStartSec / stepSec) * stepSec;
  const { past, future } = updownWindowPickerCounts(interval);
  const items: UpdownWindowPickerItem[] = [];
  const push = (offset: number) => {
    const ts = snapped - offset * stepSec;
    const slug = updownSlugAtBucket(asset, interval, ts, titled);
    const isFuture = offset < 0;
    items.push({
      slug,
      label: formatWindowLabel(interval, ts, stepSec, isFuture),
      ts,
      offset,
      isFuture,
      isCurrent: slug.trim().toLowerCase() === currentSlug.trim().toLowerCase(),
    });
  };
  for (let f = future; f >= 1; f--) push(-f);
  push(0);
  for (let p = 1; p <= past; p++) push(p);
  return items;
}
