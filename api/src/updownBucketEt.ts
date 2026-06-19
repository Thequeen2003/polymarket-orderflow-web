import { DateTime } from 'luxon';

/** Polymarket Up/Down hourly+ windows use US/Eastern edges in practice (not naive UTC epoch floors). */
const UP_DOWN_TZ = 'America/New_York';

/**
 * Floor `nowSec` to the start of the active Polymarket-style bucket in `America/New_York`.
 * - 1h: top of the hour ET
 * - 4h: 00:00, 04:00, … 20:00 ET within the calendar day
 * - 1d: midnight ET (calendar day; use `bucketFloorNoonEtUnixSec` for live daily desks)
 */
export function bucketFloorNoonEtUnixSec(nowSec: number): number {
  const dt = DateTime.fromSeconds(nowSec, { zone: UP_DOWN_TZ });
  const todayNoon = dt.startOf('day').plus({ hours: 12 });
  if (dt.toSeconds() >= todayNoon.toSeconds()) {
    return Math.floor(todayNoon.toSeconds());
  }
  return Math.floor(todayNoon.minus({ days: 1 }).toSeconds());
}

export function bucketFloorEtUnixSec(stepSec: number, nowSec: number): number {
  const dt = DateTime.fromSeconds(nowSec, { zone: UP_DOWN_TZ });
  if (stepSec === 3600) {
    return Math.floor(dt.startOf('hour').toSeconds());
  }
  if (stepSec === 14400) {
    const sod = dt.startOf('day');
    const minsSinceMidnight = dt.diff(sod, 'minutes').minutes;
    const block = Math.floor(minsSinceMidnight / (4 * 60)) * (4 * 60);
    return Math.floor(sod.plus({ minutes: block }).toSeconds());
  }
  if (stepSec === 86400) {
    return Math.floor(dt.startOf('day').toSeconds());
  }
  return Math.floor(nowSec / stepSec) * stepSec;
}

/** UTC grid floor + ET grid floor (same value when interval does not use ET alignment). */
export function updownShortcutAnchorFloors(stepSec: number, nowSec: number): { utc: number; et: number } {
  const utc = Math.floor(nowSec / stepSec) * stepSec;
  if (stepSec === 86400) {
    return { utc, et: bucketFloorNoonEtUnixSec(nowSec) };
  }
  if (stepSec !== 3600 && stepSec !== 14400) {
    return { utc, et: utc };
  }
  return { utc, et: bucketFloorEtUnixSec(stepSec, nowSec) };
}

/** True when `nowSec` is inside [bucketStartSec, bucketStartSec + stepSec). */
export function updownBucketContainsNow(bucketStartSec: number, stepSec: number, nowSec: number): boolean {
  return bucketStartSec <= nowSec && nowSec < bucketStartSec + stepSec;
}

/** Sort canonical slug timestamps: live bucket first, then nearest anchor, deprioritize future opens. */
export function compareUpdownCanonicalTryTs(
  a: number,
  c: number,
  opts: { nowSec: number; stepSec: number; anchorSec: number; preferLiveBucket: boolean },
): number {
  const { nowSec, stepSec, anchorSec, preferLiveBucket } = opts;
  if (preferLiveBucket) {
    const aLive = updownBucketContainsNow(a, stepSec, nowSec);
    const cLive = updownBucketContainsNow(c, stepSec, nowSec);
    if (aLive !== cLive) return aLive ? -1 : 1;
    if (a === anchorSec) return -1;
    if (c === anchorSec) return 1;
    const daAnchor = Math.abs(a - anchorSec);
    const dcAnchor = Math.abs(c - anchorSec);
    if (daAnchor !== dcAnchor) return daAnchor - dcAnchor;
  }
  const da = Math.abs(a - nowSec);
  const dc = Math.abs(c - nowSec);
  if (da !== dc) return da - dc;
  if (preferLiveBucket) {
    const aFuture = a > nowSec + 60;
    const cFuture = c > nowSec + 60;
    if (aFuture !== cFuture) return aFuture ? 1 : -1;
    const daAnchor = Math.abs(a - anchorSec);
    const dcAnchor = Math.abs(c - anchorSec);
    if (daAnchor !== dcAnchor) return daAnchor - dcAnchor;
  }
  return a - c;
}

/** Ordered bucket timestamps to probe — tight for 5m/15m (fast shortcuts), wider for 1h+. */
export function buildUpdownCanonicalTryTs(args: {
  stepSec: number;
  nowSec: number;
  floorSec: number;
  etAnchor: number;
  interval: '5m' | '15m' | '1h' | '4h' | '1d';
}): number[] {
  const { stepSec, nowSec, floorSec, etAnchor, interval } = args;
  const utcAnchor = Math.floor(nowSec / stepSec) * stepSec;
  const bases =
    interval === '1h' || interval === '4h' || interval === '1d'
      ? Array.from(new Set([etAnchor, utcAnchor]))
      : [floorSec];
  const spread = interval === '5m' || interval === '15m' ? 2 : interval === '1h' ? 4 : 6;
  const tryTs: number[] = [];
  for (const base of bases) {
    for (let i = 0; i <= spread; i++) {
      if (i === 0) tryTs.push(base);
      else {
        tryTs.push(base - i * stepSec);
        tryTs.push(base + i * stepSec);
      }
    }
  }
  const preferLive = interval === '15m' || interval === '1h' || interval === '4h' || interval === '1d';
  const anchor =
    interval === '1h' || interval === '4h' || interval === '1d' ? etAnchor : floorSec;
  return Array.from(new Set(tryTs)).sort((a, c) =>
    compareUpdownCanonicalTryTs(a, c, { nowSec, stepSec, anchorSec: anchor, preferLiveBucket: preferLive }),
  );
}

/** Skip early-open future buckets when resolving desk slugs (5m may intentionally use next window). */
export function shouldSkipFutureUpdownBucketStart(
  interval: '5m' | '15m' | '1h' | '4h' | '1d',
  bucketStartSec: number,
  nowSec: number,
): boolean {
  return interval !== '5m' && bucketStartSec > nowSec + 60;
}
