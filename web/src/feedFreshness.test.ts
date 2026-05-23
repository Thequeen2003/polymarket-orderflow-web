import { describe, expect, it } from 'vitest';

import { appendLiveMidSeries, maxFeedMs, normalizeEpochMs, seedProbSeriesFromLiveMid } from './feedFreshness';

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

  it('seedProbSeriesFromLiveMid seeds cold buffer', () => {
    const out = seedProbSeriesFromLiveMid([], 0.62, 50_000);
    expect(out.length).toBe(3);
    expect(out[2]!.v).toBe(0.62);
  });
});
