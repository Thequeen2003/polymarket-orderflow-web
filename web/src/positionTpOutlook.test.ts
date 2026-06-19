import { describe, expect, it } from 'vitest';
import { computeHeldLaneTpOutlook, computePositionTpOutlook, computePreBuyTpOutlook } from './positionTpOutlook';

describe('computePositionTpOutlook', () => {
  it('returns null without valid entry/tp/current', () => {
    expect(computePositionTpOutlook({ entry01: null, tp01: 0.65, current01: 0.55 })).toBeNull();
  });

  it('favors take_profit or greedy when price is at or past TP with weak momentum', () => {
    const history = [0.5, 0.52, 0.55, 0.58, 0.6, 0.62, 0.63, 0.62, 0.61];
    const r = computePositionTpOutlook({
      entry01: 0.5,
      tp01: 0.62,
      current01: 0.63,
      midHistory: history,
    });
    expect(r).not.toBeNull();
    expect(r!.progressToTp01).toBeGreaterThan(0.95);
    expect(['take_profit', 'greedy', 'bank']).toContain(r!.posture);
    expect(r!.tpHitProb01).toBeGreaterThan(0.7);
  });

  it('flags stop_pushing when underwater with deteriorating tape', () => {
    const history = [0.58, 0.56, 0.54, 0.52, 0.5, 0.48];
    const r = computePositionTpOutlook({
      entry01: 0.55,
      tp01: 0.65,
      current01: 0.48,
      midHistory: history,
      crossProb: 0.3,
    });
    expect(r).not.toBeNull();
    expect(r!.tpHitProb01).toBeLessThan(0.45);
    expect(['stop_pushing', 'hold', 'bank']).toContain(r!.posture);
  });

  it('shows constructive hold odds mid-path with supportive slope', () => {
    const history = [0.5, 0.51, 0.52, 0.53, 0.54, 0.55];
    const r = computePositionTpOutlook({
      entry01: 0.5,
      tp01: 0.62,
      current01: 0.55,
      midHistory: history,
      crossProb: 0.55,
    });
    expect(r).not.toBeNull();
    expect(r!.tpHitProb01).toBeGreaterThan(0.35);
    expect(r!.distanceToTpCents).toBeCloseTo(7, 0);
  });
});

describe('computePreBuyTpOutlook', () => {
  it('estimates TP hit odds from planned entry, staged TP, and live tape', () => {
    const r = computePreBuyTpOutlook({
      entry01: 0.52,
      tpCents: '65',
      current01: 0.55,
      probSeries: [{ t: 1, v: 0.52 }, { t: 2, v: 0.54 }, { t: 3, v: 0.55 }],
      crossProb: 0.55,
    });
    expect(r).not.toBeNull();
    expect(r!.tpCents).toBeCloseTo(65, 0);
    expect(r!.entryCents).toBeCloseTo(52, 0);
    expect(r!.tpHitProb01).toBeGreaterThan(0.3);
    expect(r!.headline).toMatch(/Before fill/);
  });

  it('returns null without staged TP', () => {
    expect(
      computePreBuyTpOutlook({
        entry01: 0.52,
        tpCents: '',
        current01: 0.55,
      }),
    ).toBeNull();
  });
});

describe('computeHeldLaneTpOutlook', () => {
  it('uses armed tp and tag entry when provided', () => {
    const r = computeHeldLaneTpOutlook({
      heldLane: 'up',
      heldAtMid01: 0.52,
      currentMid01: 0.58,
      entry01: 0.52,
      tp01: 0.65,
      probSeries: [{ t: 1, v: 0.52 }, { t: 2, v: 0.55 }, { t: 3, v: 0.58 }],
    });
    expect(r).not.toBeNull();
    expect(r!.tpCents).toBeCloseTo(65, 0);
    expect(r!.entryCents).toBeCloseTo(52, 0);
  });
});
