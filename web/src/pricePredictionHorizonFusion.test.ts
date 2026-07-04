import { describe, expect, it } from 'vitest';
import {
  buildHorizonFusionGrid,
  classifyConfirmedBandZone,
  confirmedBandLabel,
} from './pricePredictionHorizonFusion';
import { computePricePredictionSignal } from './pricePredictionSignal';

describe('classifyConfirmedBandZone', () => {
  it('labels in band, confirmed above, and confirmed below', () => {
    expect(classifyConfirmedBandZone(100, 101, 99)).toBe('in_band');
    expect(classifyConfirmedBandZone(102, 101, 99)).toBe('above');
    expect(classifyConfirmedBandZone(98, 101, 99)).toBe('below');
    expect(confirmedBandLabel('in_band')).toBe('In the Band');
    expect(confirmedBandLabel('above')).toBe('Confirmed Above');
    expect(confirmedBandLabel('below')).toBe('Confirmed Below');
  });
});

describe('buildHorizonFusionGrid', () => {
  it('flags mismatch when spot projects below PTB but Up contract leads', () => {
    const signal = computePricePredictionSignal({
      spotUsd: 61_781.5,
      slopeUsdPerSec: -0.115,
      ptbUsd: 61_780.46,
      bandUsd: 1,
      horizonSec: 30,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(signal).not.toBeNull();

    const rows = buildHorizonFusionGrid({
      signal: signal!,
      contractProb: {
        cells: [
          {
            label: 'Now',
            horizonSec: 0,
            up01: 0.655,
            down01: 0.345,
            deltaUp01: null,
            deltaDown01: null,
            confidenceUp: 1,
            confidenceDown: 1,
          },
          {
            label: 'Projected 30s',
            horizonSec: 30,
            up01: 0.782,
            down01: 0.218,
            deltaUp01: 0.127,
            deltaDown01: -0.127,
            confidenceUp: 0.95,
            confidenceDown: 0.95,
          },
        ],
        readout: {
          state: 'open',
          favoredLane: 'up',
          favoredMid01: 0.655,
          roomCents: null,
          spotAligned: null,
          momentumFlat: false,
          note: '',
        },
      },
      upLabel: 'Up',
      downLabel: 'Down',
    });

    const row30 = rows.find((r) => r.horizonSec === 30);
    expect(row30?.settlementLane).toBe('down');
    expect(row30?.contractFavored).toBe('up');
    expect(row30?.aligned).toBe(false);
    expect(row30?.mismatchNote).toMatch(/settles Down/i);
    expect(row30?.mismatchNote).toMatch(/Up/i);
  });

  it('includes BTC price and PTB gap on now row', () => {
    const signal = computePricePredictionSignal({
      spotUsd: 100,
      slopeUsdPerSec: 0,
      ptbUsd: 99,
      bandUsd: 0.5,
    });
    const rows = buildHorizonFusionGrid({
      signal: signal!,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(rows[0]?.btcUsd).toBe(100);
    expect(rows[0]?.gapVsPtbUsd).toBeGreaterThan(0);
    expect(rows[0]?.settlementLane).toBe('up');
  });

  it('attaches confirmed band zone per horizon when band edges provided', () => {
    const signal = computePricePredictionSignal({
      spotUsd: 100,
      slopeUsdPerSec: 0.2,
      ptbUsd: 100,
      bandUsd: 1,
      horizonSec: 30,
    });
    const rows = buildHorizonFusionGrid({
      signal: signal!,
      upLabel: 'Up',
      downLabel: 'Down',
      confirmedBand: { bandHi: 101, bandLo: 99 },
    });
    expect(rows[0]?.bandZone).toBe('in_band');
    const row30 = rows.find((r) => r.horizonSec === 30);
    expect(row30?.bandZone).toBe('above');
    expect(row30?.toConfirmedAboveUsd).toBeLessThanOrEqual(0);
  });
});
