import { describe, expect, it } from 'vitest';
import {
  BINARY_EXPIRY_OPTIONS,
  barIntervalMsForExpiry,
  chartIntervalMsForExpiry,
  expiryBucketProgress,
  mergeLiveIntoCandles,
  nextExpiryBucketMs,
  parseBinanceKlines,
  predictBinaryDirection,
  rebucketKlines,
  settleBinaryBet,
  type BinaryCandle,
} from './binaryCandlePredictor';

function candle(t: number, o: number, c: number, closed = true): BinaryCandle {
  return { t, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1, closed };
}

describe('binaryCandlePredictor', () => {
  it('parses binance kline rows', () => {
    const rows = parseBinanceKlines([[1_700_000_000_000, '100', '101', '99', '100.5', '12']]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.c).toBe(100.5);
    expect(rows[0]!.closed).toBe(true);
  });

  it('merges live price into trailing bar', () => {
    const base = [candle(0, 100, 100)];
    const merged = mergeLiveIntoCandles(base, 101, 500, 1_000);
    expect(merged[merged.length - 1]!.c).toBe(101);
    expect(merged[merged.length - 1]!.closed).toBe(false);
  });

  it('predicts up when live bar is green and above MAs', () => {
    const candles: BinaryCandle[] = [];
    let p = 100;
    for (let i = 0; i < 12; i++) {
      p += 0.2;
      candles.push(candle(i * 15_000, p - 0.1, p));
    }
    const pred = predictBinaryDirection({
      candles,
      livePrice: p + 0.15,
      expirySec: 30,
      nowMs: 12 * 15_000,
      buyVolRecent: 80,
      sellVolRecent: 20,
    });
    expect(pred.direction).toBe('up');
    expect(pred.probUp).toBeGreaterThan(0.5);
  });

  it('settles binary bets vs strike', () => {
    expect(settleBinaryBet('up', 100, 101)).toBe('win');
    expect(settleBinaryBet('down', 100, 101)).toBe('loss');
    expect(settleBinaryBet('up', 100, 100)).toBe('push');
  });

  it('aligns expiry buckets', () => {
    expect(nextExpiryBucketMs(10_001, 3)).toBe(12_000);
    expect(expiryBucketProgress(11_000, 3)).toBeCloseTo(2 / 3, 5);
  });

  it('bar interval matches expiry window', () => {
    expect(barIntervalMsForExpiry(3)).toBe(3_000);
    expect(barIntervalMsForExpiry(300)).toBe(300_000);
    for (const o of BINARY_EXPIRY_OPTIONS) {
      expect(chartIntervalMsForExpiry(o.sec)).toBe(o.sec * 1000);
    }
  });

  it('rebucket klines to exact bar size', () => {
    const oneMin = [
      candle(0, 100, 101),
      candle(60_000, 101, 102),
      candle(120_000, 102, 103),
      candle(180_000, 103, 104),
      candle(240_000, 104, 105),
    ];
    const fiveMin = rebucketKlines(oneMin, 300_000);
    expect(fiveMin).toHaveLength(1);
    expect(fiveMin[0]!.o).toBe(100);
    expect(fiveMin[0]!.c).toBe(105);
  });
});
