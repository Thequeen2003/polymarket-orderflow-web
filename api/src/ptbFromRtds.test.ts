import { describe, expect, it } from 'vitest';
import {
  bucketPtbCacheKey,
  chainlinkUsdHistory,
  dedupeRtdsHistPreferChainlink,
  derivePtbFromRtdsHistory,
  derivePtbFromRtdsHistoryBestEffort,
  derivePtbNearestOpenTick,
  derivePtbPreview,
  historyCoversBucketOpen,
  isLockedPtbSource,
  openTickGraceMsForBucket,
} from './ptbFromRtds.js';

describe('derivePtbFromRtdsHistory', () => {
  const open = 1_780_265_400_000;

  it('uses first Chainlink tick at/after window open', () => {
    const hist = [
      { t: open - 2000, v: 73_500, src: 'chainlink' as const },
      { t: open, v: 73_613.08, src: 'chainlink' as const },
      { t: open + 1000, v: 73_620, src: 'chainlink' as const },
    ];
    expect(derivePtbFromRtdsHistory(hist, open)).toBe(73_613.08);
  });

  it('prefers Chainlink over Binance at the same open timestamp', () => {
    const hist = [
      { t: open, v: 73_821.99, src: 'binance' as const },
      { t: open, v: 73_718.77771610889, src: 'chainlink' as const },
    ];
    expect(derivePtbFromRtdsHistory(hist, open)).toBeCloseTo(73_718.77771610889, 4);
  });

  it('rejects ticks far past window open when history is incomplete', () => {
    const hist = [{ t: open + 300_000, v: 73_900, src: 'chainlink' as const }];
    expect(derivePtbFromRtdsHistory(hist, open)).toBeNull();
  });

  it('accepts late open tick when grace window is widened', () => {
    const hist = [{ t: open + 26_000, v: 73_900, src: 'chainlink' as const }];
    expect(derivePtbFromRtdsHistory(hist, open, { openTickGraceMs: 90_000 })).toBe(73_900);
  });

  it('falls back to last tick before open when bucket is live but open tick missing', () => {
    const hist = [
      { t: open - 3000, v: 73_500, src: 'chainlink' as const },
      { t: open - 1000, v: 73_580, src: 'chainlink' as const },
    ];
    expect(derivePtbFromRtdsHistory(hist, open)).toBe(73_580);
  });

  it('returns null pre-open when fallback disabled', () => {
    const hist = [{ t: open - 1000, v: 73_580, src: 'chainlink' as const }];
    expect(derivePtbFromRtdsHistory(hist, open, { allowPreOpenFallback: false })).toBeNull();
  });
});

describe('dedupeRtdsHistPreferChainlink', () => {
  it('collapses duplicate timestamps', () => {
    const out = dedupeRtdsHistPreferChainlink([
      { t: 100, v: 73_821.99, src: 'binance' },
      { t: 100, v: 73_718.78, src: 'chainlink' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.v).toBeCloseTo(73_718.78, 2);
  });
});

describe('chainlinkUsdHistory', () => {
  it('drops Binance-looking USD ticks without chainlink precision', () => {
    const out = chainlinkUsdHistory([
      { t: 100, v: 73_857.99 },
      { t: 101, v: 73_750.91021515518, src: 'chainlink' },
    ]);
    expect(out.map((p) => p.v)).toEqual([73_750.91021515518]);
  });
});

describe('openTickGraceMsForBucket', () => {
  it('widens grace as the window ages', () => {
    expect(openTickGraceMsForBucket(10_000)).toBe(15_000);
    expect(openTickGraceMsForBucket(60_000)).toBe(90_000);
    expect(openTickGraceMsForBucket(200_000)).toBe(300_000);
  });
});

describe('historyCoversBucketOpen', () => {
  const open = 1_780_265_100_000;

  it('true when open tick exists', () => {
    expect(historyCoversBucketOpen([{ t: open, v: 1 }], open)).toBe(true);
  });

  it('false when history empty', () => {
    expect(historyCoversBucketOpen([], open)).toBe(false);
  });
});

describe('derivePtbPreview', () => {
  const open = 1_780_266_000_000;

  it('uses last chainlink tick before window open', () => {
    const hist = [
      { t: open - 2000, v: 73_700, src: 'chainlink' as const },
      { t: open - 500, v: 73_718.78, src: 'chainlink' as const },
    ];
    expect(derivePtbPreview(hist, open, null)).toBeCloseTo(73_718.78, 2);
  });

  it('falls back to live spot when no before-open ticks', () => {
    expect(derivePtbPreview([], open, 73_800.12)).toBeCloseTo(73_800.12, 2);
  });
});

describe('isLockedPtbSource', () => {
  it('locks window open sources only', () => {
    expect(isLockedPtbSource('rtds_chainlink_window_open')).toBe(true);
    expect(isLockedPtbSource('rtds_chainlink_preview_pre_open')).toBe(false);
    expect(isLockedPtbSource('polymarket_page_open_price')).toBe(true);
  });
});

describe('derivePtbNearestOpenTick', () => {
  const open = 1_700_000_000_000;

  it('picks the first chainlink tick within maxAfterOpenMs of window open', () => {
    const hist = [
      { t: open + 120_000, v: 73_750, src: 'chainlink' as const },
      { t: open + 240_000, v: 73_800, src: 'chainlink' as const },
    ];
    expect(derivePtbNearestOpenTick(hist, open)).toBeCloseTo(73_750, 2);
  });
});

describe('derivePtbFromRtdsHistoryBestEffort', () => {
  const open = 1_700_000_000_000;

  it('falls back to nearest open tick when strict grace misses', () => {
    const hist = [{ t: open + 90_000, v: 73_740, src: 'chainlink' as const }];
    expect(derivePtbFromRtdsHistoryBestEffort(hist, open, 120_000)).toBeCloseTo(73_740, 2);
  });
});