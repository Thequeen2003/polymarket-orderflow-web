import { describe, expect, it } from 'vitest';
import { evaluateTick } from './entryDecisionEngine';
import { defaultAlertPrefs, tradePlan65To70 } from './momentumAlertsTypes';
import type { BookSnapshot } from './orderflowMetrics';

describe('momentum_catch', () => {
  const t0 = 1_700_000_000_000;
  const baseSnap: BookSnapshot = {
    t: t0,
    mid: 0.648,
    spread: 0.02,
    bidDepth: 10,
    askDepth: 10,
    imbalance: 0.08,
    churn: 2,
  };

  it('fires when mid is in entry band, slope ≥ threshold, spread ok', () => {
    const mids = Array.from({ length: 24 }, (_, i) => ({
      t: t0 + i * 1000,
      v: 0.632 + i * 0.0011,
    }));
    const lastMid = mids[mids.length - 1]!.v;
    expect(lastMid).toBeGreaterThan(0.64);
    expect(lastMid).toBeLessThan(0.67);
    const out = evaluateTick({
      slug: 'x',
      t: t0,
      mid: lastMid,
      snap: baseSnap,
      bestBidSize: 10,
      bestAskSize: 10,
      wall: { bidWall: false, askWall: false, bidRatio: 1, askRatio: 1 },
      mids,
      snaps: Array(12)
        .fill(0)
        .map((_, j) => ({ ...baseSnap, t: t0 + j * 500 })),
      prevBestBid: 10,
      prevBestAsk: 10,
      prevSlope: 0.0001,
      plan: { ...tradePlan65To70(), momentumThreshold: '0.0005' },
      prefs: { ...defaultAlertPrefs() },
      momentumThreshold: 0.0005,
    });
    expect(out.some((e) => e.kind === 'momentum_catch')).toBe(true);
  });

  it('does not fire when spread is too wide', () => {
    const mids = Array.from({ length: 24 }, (_, i) => ({
      t: t0 + i * 1000,
      v: 0.632 + i * 0.0011,
    }));
    const lastMid = mids[mids.length - 1]!.v;
    const out = evaluateTick({
      slug: 'x',
      t: t0,
      mid: lastMid,
      snap: { ...baseSnap, spread: 0.08 },
      bestBidSize: 10,
      bestAskSize: 10,
      wall: { bidWall: false, askWall: false, bidRatio: 1, askRatio: 1 },
      mids,
      snaps: Array(12)
        .fill(0)
        .map((_, j) => ({ ...baseSnap, t: t0 + j * 500 })),
      prevBestBid: 10,
      prevBestAsk: 10,
      prevSlope: 0.0001,
      plan: { ...tradePlan65To70(), momentumThreshold: '0.0005' },
      prefs: { ...defaultAlertPrefs() },
      momentumThreshold: 0.0005,
    });
    expect(out.some((e) => e.kind === 'momentum_catch')).toBe(false);
  });
});
