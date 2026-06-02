import { describe, expect, it } from 'vitest';

import {
  appendLiveMidSeries,
  appendLiveSpotSeries,
  maxFeedMs,
  normalizeEpochMs,
  seedProbSeriesFromLiveMid,
} from './feedFreshness';

describe('feedFreshness', () => {
  it('normalizes epoch seconds to ms', () => {
    expect(normalizeEpochMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(normalizeEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('maxFeedMs picks the newest clock', () => {
    expect(maxFeedMs(1_700_000_000_000, 1_700_000_005_000, null)).toBe(1_700_000_005_000);
  });

  it('appendLiveMidSeries adds a point when anchor is newer', () => {
    const out = appendLiveMidSeries([{ t: 1000, v: 0.5 }], 0.55, 10_000);
    expect(out[out.length - 1]).toEqual({ t: 10_000, v: 0.55 });
  });

  it('appendLiveMidSeries refreshes last point when mid moves inside debounce window', () => {
    const out = appendLiveMidSeries(
      [
        { t: 9_000, v: 0.48 },
        { t: 10_000, v: 0.5 },
      ],
      0.52,
      10_200,
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ t: 10_000, v: 0.52 });
  });

  it('appendLiveSpotSeries refreshes last point when spot moves', () => {
    const out = appendLiveSpotSeries([{ t: 1000, v: 100 }], 101, 1500);
    expect(out).toHaveLength(1);
    expect(out[0]!.v).toBe(101);
  });

  it('seedProbSeriesFromLiveMid seeds cold buffer', () => {
    const out = seedProbSeriesFromLiveMid([], 0.62, 50_000);
    expect(out.length).toBe(3);
    expect(out[2]!.v).toBe(0.62);
  });
});
