import { describe, expect, it } from 'vitest';
import { buildNowPriceBandDistances, buildProjectionNowWindow } from './nowPriceSignals';

describe('buildNowPriceBandDistances', () => {
  it('computes confirmed band distances from PTB and now', () => {
    const d = buildNowPriceBandDistances({ now: 73_850, ptb: 73_718, bandUsd: 2.5 });
    expect(d).not.toBeNull();
    expect(d!.bandHi).toBeCloseTo(73_720.5);
    expect(d!.bandLo).toBeCloseTo(73_715.5);
    expect(d!.distAboveFromPtb).toBeCloseTo(2.5);
    expect(d!.distBelowFromPtb).toBeCloseTo(2.5);
    expect(d!.distNowFromPtb).toBeCloseTo(132);
    expect(d!.geo).toBe('ABOVE');
    expect(d!.toConfirmedAboveFromNow).toBeCloseTo(-129.5);
    expect(d!.toConfirmedBelowFromNow).toBeCloseTo(134.5);
  });

  it('flags in-band when spot sits inside confirmation band', () => {
    const d = buildNowPriceBandDistances({ now: 73_719, ptb: 73_718, bandUsd: 2.5 });
    expect(d!.geo).toBe('IN_BAND');
    expect(d!.toConfirmedAboveFromNow).toBeCloseTo(1.5);
    expect(d!.toConfirmedBelowFromNow).toBeCloseTo(3.5);
  });
});

describe('buildProjectionNowWindow', () => {
  it('projects horizons and classifies zones vs confirmed bands', () => {
    const cells = buildProjectionNowWindow({
      now: 73_850,
      slopeUsdPerSec: 0.5,
      bandHi: 73_720.5,
      bandLo: 73_715.5,
      distAboveFromPtb: 2.5,
      distBelowFromPtb: 2.5,
    });
    expect(cells.length).toBeGreaterThan(0);
    expect(cells[0]!.label).toBe('15s');
    expect(cells[0]!.price).toBeCloseTo(73_857.5);
    expect(cells[0]!.zone).toBe('above');
    expect(cells[0]!.pctTowardAbove).not.toBeNull();
    expect(cells[0]!.aboveInBands).not.toBeNull();
  });
});
