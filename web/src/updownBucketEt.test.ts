import { describe, expect, it } from 'vitest';

import { bucketFloorEtUnixSec, bucketFloorNoonEtUnixSec } from './updownBucketEt';
import { buildTitledDailySlug, buildTitledDailySlugFromBucketSec } from './updownTitledSlugs';

describe('updownBucketEt', () => {
  it('keeps 5m / 15m on UTC grid', () => {
    const now = 1_738_000_000;
    expect(bucketFloorEtUnixSec(300, now)).toBe(Math.floor(now / 300) * 300);
    expect(bucketFloorEtUnixSec(900, now)).toBe(Math.floor(now / 900) * 900);
  });

  it('daily noon floor matches Polymarket noon→noon ET window', () => {
    const evening = 1_781_135_660;
    expect(bucketFloorNoonEtUnixSec(evening)).toBe(1_781_107_200);
    expect(buildTitledDailySlugFromBucketSec('btc', 1_781_107_200)).toBe('bitcoin-up-or-down-on-june-11-2026');
    expect(buildTitledDailySlug('btc', 0, new Date(evening * 1000))).toBe('bitcoin-up-or-down-on-june-11-2026');
  });

  it('4h floor matches Polymarket ET block start', () => {
    // June 10, 2026 7:54pm ET → 4:00pm ET block (btc-updown-4h-1781121600)
    const nowSec = 1_781_135_660;
    const et = bucketFloorEtUnixSec(14_400, nowSec);
    expect(et).toBe(1_781_121_600);
    expect(et).toBeLessThanOrEqual(nowSec);
    expect(nowSec - et).toBeLessThan(14_400);
  });

});
