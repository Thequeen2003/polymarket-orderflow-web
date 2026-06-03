import { describe, expect, it } from 'vitest';

import {
  appendLiveMidSeries,
  appendLiveSpotSeries,
  maxFeedMs,
  normalizeEpochMs,
  seedProbSeriesFromLiveMid,
} from './feedFreshness';

describe('feedFreshness', () => {
  const BASE = 1_700_000_000_000;

  it('normalizes epoch seconds to ms', () => {
    expect(normalizeEpochMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(normalizeEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('maxFeedMs picks the newest clock', () => {
    expect(maxFeedMs(1_700_000_000_000, 1_700_000_005_000, null)).toBe(1_700_000_005_000);
  });

  it('appendLiveMidSeries adds a point when anchor is newer', () => {
    const out = appendLiveMidSeries([{ t: BASE, v: 0.5 }], 0.55, BASE + 5_000);
    expect(out[out.length - 1]).toEqual({ t: BASE + 5_000, v: 0.55 });
  });

  it('appendLiveMidSeries refreshes last point when mid moves inside debounce window', () => {
    const out = appendLiveMidSeries(
      [
        { t: BASE - 1_000, v: 0.48 },
        { t: BASE, v: 0.5 },
      ],
      0.52,
      BASE + 200,
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ t: BASE + 200, v: 0.52 });
  });

  it('appendLiveMidSeries bumps timestamp when mid flat but poll is newer', () => {
    const out = appendLiveMidSeries(
      [
        { t: BASE - 500, v: 0.5 },
        { t: BASE, v: 0.5 },
      ],
      0.5,
      BASE + 200,
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ t: BASE + 200, v: 0.5 });
  });

  it('appendLiveSpotSeries refreshes last point when spot moves', () => {
    const out = appendLiveSpotSeries([{ t: BASE, v: 100 }], 101, BASE + 200);
    expect(out).toHaveLength(1);
    expect(out[0]!.v).toBe(101);
    expect(out[0]!.t).toBe(BASE + 200);
  });

  it('appendLiveSpotSeries bumps timestamp when spot flat but poll is newer', () => {
    const out = appendLiveSpotSeries([{ t: BASE, v: 100 }], 100, BASE + 200);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ t: BASE + 200, v: 100 });
  });

  it('appendLiveSpotSeries keeps reference when anchor is not newer', () => {
    const base = [{ t: BASE, v: 100 }];
    expect(appendLiveSpotSeries(base, 100, BASE)).toBe(base);
  });

  it('seedProbSeriesFromLiveMid seeds cold buffer', () => {
    const out = seedProbSeriesFromLiveMid([], 0.62, BASE);
    expect(out.length).toBe(3);
    expect(out[2]!.v).toBe(0.62);
  });
});
