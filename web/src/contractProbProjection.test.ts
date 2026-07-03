import { describe, expect, it } from 'vitest';

import { buildContractProbProjectionGrid, enrichPricePredictionWithContracts } from './contractProbProjection';
import { computePricePredictionSignal } from './pricePredictionSignal';

describe('contractProbProjection', () => {
  it('builds now + 30s/1m/5m contract mid rows', () => {
    const t0 = Date.now() - 120_000;
    const probUpPts = Array.from({ length: 40 }, (_, i) => ({
      t: t0 + i * 3000,
      v: 0.12 + i * 0.0005,
    }));
    const probDownPts = Array.from({ length: 40 }, (_, i) => ({
      t: t0 + i * 3000,
      v: 0.88 - i * 0.0005,
    }));

    const grid = buildContractProbProjectionGrid({
      probUpPts,
      probDownPts,
      nowUp01: probUpPts.at(-1)!.v,
      nowDown01: probDownPts.at(-1)!.v,
    });

    expect(grid).not.toBeNull();
    expect(grid!.cells.map((c) => c.label)).toEqual(['Now', 'Projected 30s', 'Projected 1m', 'Projected 5m']);
    expect(grid!.cells[0]!.deltaUp01).toBeNull();
    expect(grid!.cells[1]!.up01).not.toBeNull();
    expect(grid!.cells[1]!.deltaUp01).not.toBeNull();
  });

  it('infers complement when only up mid is known at now', () => {
    const grid = buildContractProbProjectionGrid({
      probUpPts: [],
      probDownPts: [],
      nowUp01: 0.15,
      nowDown01: null,
    });
    expect(grid!.cells[0]!.up01).toBeCloseTo(0.15, 2);
    expect(grid!.cells[0]!.down01).toBeCloseTo(0.85, 2);
    expect(grid!.readout.state).toBe('open');
  });

  it('detects pinned down when down mid is at ceiling', () => {
    const grid = buildContractProbProjectionGrid({
      probUpPts: [],
      probDownPts: [],
      nowUp01: 0.01,
      nowDown01: 0.99,
    });
    expect(grid!.readout.state).toBe('pinned_down');
    expect(grid!.readout.favoredLane).toBe('down');
    expect(grid!.readout.roomCents).toBeCloseTo(0, 0);
    expect(grid!.cells[1]!.flatPinned).toBe(true);
  });

  it('enriches spot headline when contracts are pinned', () => {
    const signal = computePricePredictionSignal({
      spotUsd: 59_936.9,
      slopeUsdPerSec: -17.1 / 30,
      ptbUsd: 60_013,
      horizonSec: 30,
      downLabel: 'DOWN',
    });
    const grid = buildContractProbProjectionGrid({
      probUpPts: [],
      probDownPts: [],
      nowUp01: 0.01,
      nowDown01: 0.99,
    })!;
    const enriched = enrichPricePredictionWithContracts(signal!, grid, 'UP', 'DOWN');
    expect(enriched.headline).toMatch(/pinned/i);
    expect(enriched.summary).toMatch(/priced in|ceiling|below ptb/i);
  });
});
