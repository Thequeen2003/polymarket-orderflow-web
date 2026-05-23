import { describe, expect, it } from 'vitest';
import { computeTapeVelocity, type TapePrint } from './tapeVelocity';

const NOW = 1_000_000_000_000;

function buy(tsOffsetMs: number, size = 100): TapePrint {
  return { ts: NOW + tsOffsetMs, side: 'buy', size };
}

function sell(tsOffsetMs: number, size = 100): TapePrint {
  return { ts: NOW + tsOffsetMs, side: 'sell', size };
}

describe('computeTapeVelocity', () => {
  it('returns idle for empty/null input', () => {
    expect(computeTapeVelocity([], { now: NOW }).burst).toBe('idle');
    expect(computeTapeVelocity(null, { now: NOW }).reliable).toBe(false);
    expect(computeTapeVelocity(undefined, { now: NOW }).dominance).toBe('idle');
  });

  it('classifies BUYERS dominance from recent net pressure', () => {
    const prints = [buy(-2_000, 200), buy(-5_000, 150), sell(-10_000, 50), buy(-15_000, 120)];
    const v = computeTapeVelocity(prints, { now: NOW });
    expect(v.dominance).toBe('buy');
    expect(v.netPressure).toBeGreaterThan(40);
  });

  it('classifies SELLERS dominance', () => {
    const prints = [sell(-2_000, 300), sell(-5_000, 250), buy(-10_000, 50)];
    const v = computeTapeVelocity(prints, { now: NOW });
    expect(v.dominance).toBe('sell');
    expect(v.netPressure).toBeLessThan(-40);
  });

  it('reports mixed when buys ≈ sells', () => {
    const prints = [buy(-1_000, 100), sell(-2_000, 100), buy(-3_000, 100), sell(-4_000, 100)];
    const v = computeTapeVelocity(prints, { now: NOW });
    expect(v.dominance).toBe('mixed');
  });

  it('detects an aggressive burst (recent vol >> baseline rate)', () => {
    // Quiet 5min: 200 vol total, then a flurry in the last 30s with 600 vol.
    const baseline: TapePrint[] = [];
    for (let i = 0; i < 4; i++) baseline.push(buy(-(60_000 + i * 30_000), 50));
    const recent: TapePrint[] = [buy(-1_000, 200), buy(-5_000, 200), buy(-15_000, 200)];
    const v = computeTapeVelocity([...baseline, ...recent], { now: NOW });
    expect(['aggressive', 'extreme']).toContain(v.burst);
    expect(v.burstRatio).toBeGreaterThan(2);
  });

  it('falls back to "normal" when recent matches baseline rate', () => {
    const prints: TapePrint[] = [];
    for (let i = 0; i < 10; i++) prints.push(buy(-(i * 30_000), 100)); // even spacing across 5min
    const v = computeTapeVelocity(prints, { now: NOW });
    expect(['normal', 'aggressive']).toContain(v.burst);
  });

  it('reliable=false when fewer than minPrints', () => {
    const v = computeTapeVelocity([buy(-1_000, 50)], { now: NOW, minPrints: 3 });
    expect(v.reliable).toBe(false);
  });

  it('reliable=true when minPrints met', () => {
    const v = computeTapeVelocity(
      [buy(-1_000, 50), sell(-2_000, 50), buy(-3_000, 50), sell(-4_000, 50)],
      { now: NOW, minPrints: 4 },
    );
    expect(v.reliable).toBe(true);
  });

  it('summary mentions buyers/sellers + burst + count', () => {
    const v = computeTapeVelocity([buy(-1_000, 200), buy(-2_000, 200), buy(-3_000, 200), buy(-4_000, 200)], {
      now: NOW,
    });
    expect(v.summary.toLowerCase()).toMatch(/buyers/);
    expect(v.summary).toMatch(/\d/);
  });

  it('ignores out-of-window prints', () => {
    const stale: TapePrint = { ts: NOW - 600_000, side: 'buy', size: 99999 };
    const v = computeTapeVelocity([stale], { now: NOW });
    expect(v.recent.count).toBe(0);
    expect(v.baseline.count).toBe(0);
  });
});
