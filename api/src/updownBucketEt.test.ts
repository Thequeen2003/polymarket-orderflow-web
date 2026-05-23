import { describe, expect, it } from 'vitest';
import {
  bucketFloorEtUnixSec,
  buildUpdownCanonicalTryTs,
  compareUpdownCanonicalTryTs,
  shouldSkipFutureUpdownBucketStart,
  updownBucketContainsNow,
  updownShortcutAnchorFloors,
} from './updownBucketEt.js';

describe('updownBucketEt', () => {
  it('keeps 5m / 15m aligned with UTC grid', () => {
    const now = 1_738_000_000;
    expect(updownShortcutAnchorFloors(300, now).et).toBe(updownShortcutAnchorFloors(300, now).utc);
    expect(updownShortcutAnchorFloors(900, now).et).toBe(updownShortcutAnchorFloors(900, now).utc);
  });

  it('1h ET hour floor differs from UTC hour floor near DST edges', () => {
    // Fixed instant: compare ET vs UTC hour starts — must not assume equality.
    const nowSec = 1_738_965_000;
    const et = bucketFloorEtUnixSec(3600, nowSec);
    const utc = Math.floor(nowSec / 3600) * 3600;
    expect(Math.abs(et - utc)).toBeLessThanOrEqual(3600);
    expect(et % 3600).toBe(0);
  });

  it('4h buckets are 4-hour blocks in ET same calendar day', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const et = bucketFloorEtUnixSec(14400, nowSec);
    expect(et % 3600).toBe(0);
    expect(et).toBeLessThanOrEqual(nowSec);
  });

  it('prefers live 15m bucket over nearer future open', () => {
    const stepSec = 900;
    const floor = 1_779_329_700;
    const nowSec = floor + 683;
    const future = floor + stepSec;
    expect(updownBucketContainsNow(floor, stepSec, nowSec)).toBe(true);
    expect(updownBucketContainsNow(future, stepSec, nowSec)).toBe(false);
    const sorted = [future, floor].sort((a, c) =>
      compareUpdownCanonicalTryTs(a, c, { nowSec, stepSec, anchorSec: floor, preferLiveBucket: true }),
    );
    expect(sorted[0]).toBe(floor);
  });

  it('buildUpdownCanonicalTryTs keeps 5m/15m probe lists small', () => {
    const now = 1_779_330_000;
    const floor = Math.floor(now / 300) * 300;
    const { et } = updownShortcutAnchorFloors(300, now);
    expect(buildUpdownCanonicalTryTs({ stepSec: 300, nowSec: now, floorSec: floor, etAnchor: et, interval: '5m' }).length).toBeLessThanOrEqual(
      12,
    );
    const floor15 = Math.floor(now / 900) * 900;
    const { et: et15 } = updownShortcutAnchorFloors(900, now);
    expect(
      buildUpdownCanonicalTryTs({ stepSec: 900, nowSec: now, floorSec: floor15, etAnchor: et15, interval: '15m' }).length,
    ).toBeLessThanOrEqual(12);
  });

  it('shouldSkipFutureUpdownBucketStart applies to 15m not 5m', () => {
    const now = 1_000_000;
    expect(shouldSkipFutureUpdownBucketStart('15m', now + 120, now)).toBe(true);
    expect(shouldSkipFutureUpdownBucketStart('15m', now + 30, now)).toBe(false);
    expect(shouldSkipFutureUpdownBucketStart('5m', now + 120, now)).toBe(false);
  });
});
