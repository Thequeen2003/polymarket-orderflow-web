import { describe, expect, it } from 'vitest';

import { buildContractProbProjectionGrid } from './contractProbProjection';

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
  });
});
