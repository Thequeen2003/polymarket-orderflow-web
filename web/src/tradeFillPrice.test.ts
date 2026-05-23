import { describe, expect, it } from 'vitest';
import {
  confirmedExchangeFillFromRow,
  fillCentsFrom01,
  fillPrice01FromRow,
  mirrorFillPriceOnRow,
  normalizePrice01,
} from './tradeFillPrice';

describe('tradeFillPrice', () => {
  it('normalizes cent-scale prices', () => {
    expect(normalizePrice01(80)).toBeCloseTo(0.8, 6);
    expect(normalizePrice01(0.8)).toBeCloseTo(0.8, 6);
  });

  it('uses fillAvg only for display', () => {
    expect(
      fillPrice01FromRow({
        fillAvgPrice01: 0.8,
        submittedPrice01: 0.75,
        intendedPrice01: 0.75,
        price01: 0.82,
      } as never),
    ).toBeCloseTo(0.8, 6);
  });

  it('fillCentsFrom01 rounds to one decimal cent', () => {
    expect(fillCentsFrom01(0.86)).toBeCloseTo(86, 6);
    expect(fillCentsFrom01(0.862)).toBeCloseTo(86.2, 6);
  });

  it('confirmedExchangeFillFromRow uses filled shares not requested', () => {
    const fill = confirmedExchangeFillFromRow({
      mode: 'live',
      side: 'sell',
      status: 'filled',
      fillAvgPrice01: 0.86,
      shares: 12.5,
      requestedShares: 20,
      remainingShares: 0,
    } as never);
    expect(fill?.fillCents).toBeCloseTo(86, 6);
    expect(fill?.shares).toBeCloseTo(12.5, 6);
  });

  it('mirrorFillPriceOnRow copies VWAP to price01', () => {
    const p = mirrorFillPriceOnRow({ fillAvgPrice01: 0.86, shares: 10 });
    expect(p.price01).toBeCloseTo(0.86, 6);
    expect(p.usdCents).toBe(860);
  });
});
