import { describe, expect, it } from 'vitest';
import {
  binaryBiasFromCandles,
  merge5mTo10m,
  parseKlines,
  priceMovementFromCandles,
  type BtcUsdCandle,
} from './btcUsdCandles';

function candle(t: number, o: number, h: number, l: number, c: number, v = 1): BtcUsdCandle {
  return { t, o, h, l, c, v };
}

describe('btcUsdCandles', () => {
  it('parses Binance kline rows', () => {
    const raw = [[1000, 100, 110, 90, 105, 12.5]];
    expect(parseKlines(raw)).toEqual([candle(1000, 100, 110, 90, 105, 12.5)]);
  });

  it('merges 5m pairs into 10m', () => {
    const five = [
      candle(0, 100, 102, 99, 101, 1),
      candle(300_000, 101, 104, 100, 103, 2),
      candle(600_000, 103, 105, 102, 104, 1),
      candle(900_000, 104, 106, 103, 105, 3),
    ];
    const ten = merge5mTo10m(five);
    expect(ten).toHaveLength(2);
    expect(ten[0]).toMatchObject({ t: 0, o: 100, h: 104, l: 99, c: 103, v: 3 });
    expect(ten[1]).toMatchObject({ t: 600_000, o: 103, h: 106, l: 102, c: 105, v: 4 });
  });

  it('summarizes price movement', () => {
    const rows = Array.from({ length: 10 }, (_, i) => candle(i * 60_000, 100 + i, 101 + i, 99 + i, 100.5 + i, 1));
    const m = priceMovementFromCandles(rows, 10);
    expect(m).not.toBeNull();
    expect(m!.changePct).toBeGreaterThan(0);
    expect(m!.bullishBars + m!.bearishBars).toBe(10);
  });

  it('returns WAIT when candles are thin', () => {
    const rows = Array.from({ length: 5 }, (_, i) => candle(i, 100, 101, 99, 100, 1));
    expect(binaryBiasFromCandles(rows).verdict).toBe('WAIT');
  });
});
