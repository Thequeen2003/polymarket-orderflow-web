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

  describe('micro-window (10s) leading indicator', () => {
    it('populates micro fields when prints exist in the last 10s', () => {
      const prints = [buy(-2_000, 200), buy(-5_000, 150), buy(-8_000, 100)];
      const v = computeTapeVelocity(prints, { now: NOW });
      expect(v.micro.count).toBe(3);
      expect(v.micro.buyVol).toBe(450);
      expect(v.microReliable).toBe(true);
      expect(v.microDominance).toBe('buy');
    });

    it('microReliable=false when only 1 print in micro window', () => {
      const prints = [buy(-2_000, 200), buy(-15_000, 100), buy(-25_000, 100)];
      const v = computeTapeVelocity(prints, { now: NOW });
      expect(v.microReliable).toBe(false);
    });

    it('detects surging acceleration when micro is much hotter than rest of recent', () => {
      // Quiet 20-30s window, then burst in last 10s
      const baseline = [buy(-120_000, 50), sell(-90_000, 50)];
      const restOfRecent = [buy(-20_000, 30), buy(-25_000, 30)];
      const microBurst = [buy(-2_000, 300), buy(-4_000, 250), buy(-7_000, 200)];
      const v = computeTapeVelocity([...baseline, ...restOfRecent, ...microBurst], { now: NOW });
      expect(v.acceleration).toBe('surging');
      expect(v.microDominance).toBe('buy');
    });

    it('detects building acceleration when micro is moderately hotter', () => {
      const restOfRecent = [buy(-15_000, 100), buy(-20_000, 100), sell(-25_000, 80)];
      const microPrints = [buy(-3_000, 200), buy(-6_000, 180)];
      const v = computeTapeVelocity([...restOfRecent, ...microPrints], { now: NOW });
      expect(['building', 'surging']).toContain(v.acceleration);
    });

    it('detects fading when micro is much quieter than rest of recent', () => {
      const restOfRecent = [buy(-15_000, 500), buy(-18_000, 400), buy(-22_000, 300)];
      const microQuiet = [buy(-5_000, 10), sell(-8_000, 10)];
      const v = computeTapeVelocity([...restOfRecent, ...microQuiet], { now: NOW });
      expect(v.acceleration).toBe('fading');
    });

    it('microNetPressure reflects 10s directional skew', () => {
      const prints = [buy(-2_000, 400), sell(-5_000, 50)];
      const v = computeTapeVelocity(prints, { now: NOW });
      expect(v.microNetPressure).toBeGreaterThan(60);
    });

    it('micro buy-dominance with sell-dominated full window = early reversal signal', () => {
      const older = [sell(-15_000, 300), sell(-18_000, 250), sell(-22_000, 200)];
      const recent = [buy(-2_000, 400), buy(-5_000, 350)];
      const v = computeTapeVelocity([...older, ...recent], { now: NOW });
      expect(v.microDominance).toBe('buy');
      expect(v.dominance).toBe('mixed');
      expect(['building', 'surging']).toContain(v.acceleration);
    });
  });
});
