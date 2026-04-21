import { describe, expect, it } from 'vitest';
import type { Net4cEstimate } from './executionEstimator';
import { buildUpScalpVerdict, detectWalls, firstNotableWallAbove } from './entryDecisionEngine';
import type { BookSnapshot } from './orderflowMetrics';
import { defaultUpScalpSettings } from './momentumAlertsTypes';

function fq(side: 'buy' | 'sell'): Net4cEstimate['entry'] {
  return {
    ok: true,
    side,
    sizeShares: 100,
    avgPrice: 0.5,
    worstPrice: 0.51,
    filledShares: 100,
    unfilledShares: 0,
    notional: 50,
    steps: [],
  };
}

function net4cBase(over: Partial<Net4cEstimate> & Pick<Net4cEstimate, 'ok'>): Net4cEstimate {
  return {
    ok: over.ok,
    reason: over.reason,
    entry: over.entry ?? fq('buy'),
    tpExit: over.tpExit ?? { targetPrice: 0.54, fill: fq('sell') },
    net: {
      profit01: over.net?.profit01 ?? 0.04,
      profitCents: over.net?.profitCents ?? 4,
      profitUsd: over.net?.profitUsd ?? null,
      requiredGrossCents: over.net?.requiredGrossCents ?? 8,
      spreadCents: over.net?.spreadCents ?? 2,
      entrySlippageCents: over.net?.entrySlippageCents ?? 0.5,
      exitSlippageCents: over.net?.exitSlippageCents ?? 0.5,
    },
    flags: over.flags ?? [],
  };
}

const baseSnap = (spread: number): BookSnapshot => ({
  t: Date.now(),
  mid: 0.5,
  spread,
  bidDepth: 100,
  askDepth: 100,
  imbalance: 0.1,
  churn: 20,
});

describe('buildUpScalpVerdict', () => {
  const settings = defaultUpScalpSettings();

  it('AVOID when spread exceeds maxSpreadCents', () => {
    const v = buildUpScalpVerdict({
      net4c: net4cBase({ ok: true }),
      settings,
      mid: 0.5,
      slope: 0.02,
      snap: baseSnap(0.09),
      wall: { bidWall: false, askWall: false, bidRatio: 1, askRatio: 1 },
      asks: [{ price: 0.51, size: 200 }],
      recentAlertKinds: [],
    });
    expect(v.state).toBe('AVOID');
    expect(v.headline).toMatch(/Spread/i);
  });

  it('WAIT when momentum is good but ask wall is too close', () => {
    const mid = 0.5;
    const asks = [
      { price: 0.5, size: 5 },
      { price: 0.501, size: 5 },
      { price: 0.502, size: 5 },
      { price: 0.503, size: 5 },
      { price: 0.504, size: 5 },
      { price: 0.508, size: 800 },
    ];
    const w = firstNotableWallAbove(asks, mid);
    expect(w).not.toBeNull();
    expect(w!.price - mid).toBeLessThan(settings.minAskWallDistance);

    const v = buildUpScalpVerdict({
      net4c: net4cBase({
        ok: true,
        net: {
          profit01: 0.04,
          profitCents: 4,
          profitUsd: null,
          requiredGrossCents: 8,
          spreadCents: 2,
          entrySlippageCents: 0.5,
          exitSlippageCents: 0.5,
        },
      }),
      settings,
      mid,
      slope: 0.02,
      snap: baseSnap(0.02),
      wall: detectWalls({ bids: [{ price: 0.49, size: 100 }], asks }),
      asks,
      recentAlertKinds: ['asks_eaten'],
    });
    expect(v.state).toBe('WAIT');
    const res = v.rows.find((r) => r.id === 'resistance');
    expect(res?.status).toBe('warn');
  });

  it('READY when tape is clean and net4c is ok', () => {
    const mid = 0.5;
    const asks = [
      { price: 0.51, size: 300 },
      { price: 0.55, size: 300 },
      { price: 0.6, size: 300 },
    ];
    const v = buildUpScalpVerdict({
      net4c: net4cBase({
        ok: true,
        flags: [],
        net: {
          profit01: 0.05,
          profitCents: 5,
          profitUsd: null,
          requiredGrossCents: 7,
          spreadCents: 2,
          entrySlippageCents: 0.5,
          exitSlippageCents: 0.5,
        },
      }),
      settings,
      mid,
      slope: 0.02,
      snap: baseSnap(0.02),
      wall: detectWalls({ bids: [{ price: 0.49, size: 200 }], asks }),
      asks,
      recentAlertKinds: ['asks_eaten'],
    });
    expect(v.state).toBe('READY');
  });

  it('AVOID when weak_follow appeared in recent alert kinds', () => {
    const v = buildUpScalpVerdict({
      net4c: net4cBase({ ok: true }),
      settings,
      mid: 0.5,
      slope: 0.02,
      snap: baseSnap(0.02),
      wall: { bidWall: false, askWall: false, bidRatio: 1, askRatio: 1 },
      asks: [{ price: 0.51, size: 400 }],
      recentAlertKinds: ['weak_follow'],
    });
    expect(v.state).toBe('AVOID');
    expect(v.headline).toMatch(/Weak follow/i);
  });
});
