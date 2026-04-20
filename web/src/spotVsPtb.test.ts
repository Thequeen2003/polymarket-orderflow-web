import { describe, expect, it } from 'vitest';
import { buildSpotCandles, buildSpotCandlesInRange } from './spotVsPtb';

describe('buildSpotCandles', () => {
  it('includes the final tick in the last bucket when it equals series end time', () => {
    const pts = [
      { t: 0, v: 100 },
      { t: 100, v: 101 },
    ];
    const candles = buildSpotCandles(pts, 2);
    expect(candles.length).toBe(2);
    const last = candles[1]!;
    expect(last.t1).toBe(100);
    expect(last.c).toBe(101);
  });
});

describe('buildSpotCandlesInRange', () => {
  it('includes ticks at window end t1 in the last bucket', () => {
    const pts = [
      { t: 0, v: 1 },
      { t: 50, v: 2 },
      { t: 100, v: 3 },
    ];
    const candles = buildSpotCandlesInRange(pts, 0, 100, 2);
    expect(candles.length).toBe(2);
    expect(candles[1]!.c).toBe(3);
  });
});
