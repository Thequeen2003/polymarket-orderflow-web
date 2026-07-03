import { describe, expect, it } from 'vitest';
import {
  analyzeDeskMomentum,
  createDeskMomentumTracker,
  pivotHighTrailCents,
  pushDeskMomentumSample,
} from './deskMomentumTracker';
import { buildPositionDeskSignal } from './positionDeskSignal';
import { computePositionBracketCall } from './positionBracketCall';

function pushSeries(
  lane: 'up' | 'down',
  rows: { mid: number; deskTp: number; up: number; down: number; ms: number }[],
) {
  let state = createDeskMomentumTracker(lane);
  for (const r of rows) {
    state = pushDeskMomentumSample(state, {
      focusLane: lane,
      ms: r.ms,
      focusMid01: r.mid,
      liveDeskTp01: r.deskTp,
      upMid01: r.up,
      downMid01: r.down,
    });
  }
  return state;
}

describe('pivotHighTrailCents', () => {
  it('extracts 62 → 67 → 68 style highs', () => {
    const trail = pivotHighTrailCents([0.6, 0.62, 0.67, 0.68, 0.675, 0.67]);
    expect(trail.length).toBeGreaterThanOrEqual(2);
    expect(trail).toContain(62);
    expect(trail[trail.length - 1]).toBeCloseTo(68, 0);
  });
});

describe('analyzeDeskMomentum', () => {
  it('flags stall when desk TP drops while mid holds near peak', () => {
    const state = pushSeries('up', [
      { ms: 1000, mid: 0.6, deskTp: 0.7, up: 0.6, down: 0.4 },
      { ms: 2000, mid: 0.62, deskTp: 0.72, up: 0.62, down: 0.38 },
      { ms: 3000, mid: 0.67, deskTp: 0.74, up: 0.67, down: 0.35 },
      { ms: 4000, mid: 0.68, deskTp: 0.75, up: 0.68, down: 0.34 },
      { ms: 5000, mid: 0.675, deskTp: 0.71, up: 0.675, down: 0.36 },
      { ms: 6000, mid: 0.67, deskTp: 0.65, up: 0.67, down: 0.38 },
    ]);
    const r = analyzeDeskMomentum({ state, upLabel: 'UP', downLabel: 'DOWN' });
    expect(r).not.toBeNull();
    expect(['stagnating', 'reversing', 'switched']).toContain(r!.phase);
    expect(r!.deskTpLeadDropCents).not.toBeNull();
    expect(r!.deskTpLeadDropCents!).toBeGreaterThanOrEqual(0.7);
    expect(r!.exitPressure).toBeGreaterThan(40);
  });

  it('flags switched when book flips to DOWN after UP climb', () => {
    const state = pushSeries('up', [
      { ms: 1000, mid: 0.62, deskTp: 0.72, up: 0.62, down: 0.38 },
      { ms: 2000, mid: 0.67, deskTp: 0.74, up: 0.67, down: 0.35 },
      { ms: 3000, mid: 0.68, deskTp: 0.75, up: 0.68, down: 0.34 },
      { ms: 4000, mid: 0.66, deskTp: 0.66, up: 0.66, down: 0.36 },
      { ms: 5000, mid: 0.64, deskTp: 0.62, up: 0.44, down: 0.58 },
      { ms: 6000, mid: 0.63, deskTp: 0.6, up: 0.42, down: 0.6 },
    ]);
    const r = analyzeDeskMomentum({ state });
    expect(r!.phase).toBe('switched');
    expect(r!.winningLane).toBe('down');
    expect(r!.exitPressure).toBeGreaterThan(80);
  });

  it('flags early fade before full stall climb', () => {
    const state = pushSeries('up', [
      { ms: 1000, mid: 0.58, deskTp: 0.68, up: 0.58, down: 0.42 },
      { ms: 2000, mid: 0.59, deskTp: 0.69, up: 0.59, down: 0.41 },
      { ms: 3000, mid: 0.575, deskTp: 0.66, up: 0.575, down: 0.425 },
    ]);
    const r = analyzeDeskMomentum({ state });
    expect(r!.phase).toBe('fading');
    expect(r!.exitPressure).toBeGreaterThan(50);
  });

  it('shows climbing while mid and desk TP still rise', () => {
    const state = pushSeries('up', [
      { ms: 1000, mid: 0.6, deskTp: 0.68, up: 0.6, down: 0.4 },
      { ms: 2000, mid: 0.62, deskTp: 0.7, up: 0.62, down: 0.38 },
      { ms: 3000, mid: 0.65, deskTp: 0.72, up: 0.65, down: 0.36 },
      { ms: 4000, mid: 0.67, deskTp: 0.74, up: 0.67, down: 0.35 },
    ]);
    const r = analyzeDeskMomentum({ state });
    expect(r!.phase).toBe('climbing');
    expect(r!.exitPressure).toBeLessThan(25);
  });
});

describe('buildPositionDeskSignal', () => {
  it('sell_now on stall with large desk TP lead drop even if bracket still hold', () => {
    const state = pushSeries('up', [
      { ms: 1000, mid: 0.62, deskTp: 0.72, up: 0.62, down: 0.38 },
      { ms: 2000, mid: 0.67, deskTp: 0.74, up: 0.67, down: 0.35 },
      { ms: 3000, mid: 0.68, deskTp: 0.75, up: 0.68, down: 0.34 },
      { ms: 4000, mid: 0.675, deskTp: 0.71, up: 0.675, down: 0.36 },
      { ms: 5000, mid: 0.67, deskTp: 0.62, up: 0.67, down: 0.38 },
    ]);
    const momentum = analyzeDeskMomentum({ state })!;
    const bracket = computePositionBracketCall({
      entry01: 0.6,
      armedTp01: 0.72,
      liveDeskTp01: 0.62,
      bid01: 0.66,
    })!;
    expect(bracket.action).toBe('hold');
    const sig = buildPositionDeskSignal({ bracket, momentum })!;
    expect(['sell_now', 'watch']).toContain(sig.action);
    expect(sig.midTrailCents.length).toBeGreaterThanOrEqual(2);
  });
});
