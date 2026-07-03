import { describe, expect, it } from 'vitest';
import {
  computeMeanGainTakeProfit,
  computeWatchStopFromPct,
  evaluateOneSignalSnapshot,
  oneSignalSessionKey,
  sharesFromUsdNotional,
} from './oneSignalSessionAutoTrade';

describe('oneSignalSessionKey', () => {
  it('buckets into 25-minute windows', () => {
    const bucketMs = 25 * 60_000;
    expect(oneSignalSessionKey(0)).toBe('0');
    expect(oneSignalSessionKey(bucketMs - 1)).toBe('0');
    expect(oneSignalSessionKey(bucketMs)).toBe('1');
  });
});

describe('sharesFromUsdNotional', () => {
  it('converts $150 at 60¢ entry', () => {
    expect(sharesFromUsdNotional(150, 0.6)).toBe(250);
  });
});

describe('computeMeanGainTakeProfit', () => {
  it('targets above entry using mean drift', () => {
    const r = computeMeanGainTakeProfit(0.6, [0.61, 0.62, 0.615]);
    expect(r.takeProfit01).toBeGreaterThan(0.6);
    expect(r.gainPct).toBeGreaterThanOrEqual(0.03);
  });
});

describe('computeWatchStopFromPct', () => {
  it('places watch stop below UP entry', () => {
    expect(computeWatchStopFromPct(0.6, 0.06, 'up')).toBeLessThan(0.6);
  });
});

describe('evaluateOneSignalSnapshot', () => {
  const base = {
    market: { slug: 'btc-updown-15m-1' },
    window: { remainingMs: 8 * 60_000 },
    underlying: { spotVsPtbUsd: 42, spot: { history: [{ usd: 97000 }] } },
    outcomes: {
      up: { lane: 'up' as const, impliedMid: 0.62, recentTrades: [{ price: 0.61, side: 'BUY' }] },
      down: { lane: 'down' as const, impliedMid: 0.38, recentTrades: [{ price: 0.39, side: 'SELL' }] },
    },
  };

  it('passes clear UP signal', () => {
    const r = evaluateOneSignalSnapshot(base);
    expect(r.ok).toBe(true);
    expect(r.lane).toBe('up');
    expect(r.takeProfit01).toBeGreaterThan(0.62);
    expect(r.watchStop01).toBeLessThan(0.62);
  });

  it('blocks when spot too close to PTB', () => {
    const r = evaluateOneSignalSnapshot({
      ...base,
      underlying: { ...base.underlying, spotVsPtbUsd: 1 },
    });
    expect(r.ok).toBe(false);
  });
});
