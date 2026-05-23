import { describe, expect, it } from 'vitest';
import { buildSpotProjectionGrid, projectSpotLinear } from './spotPriceProjection';

describe('projectSpotLinear', () => {
  it('extrapolates by slope × seconds', () => {
    expect(projectSpotLinear(100_000, 1, 60)).toBe(100_060);
    expect(projectSpotLinear(100_000, -0.5, 120)).toBe(99_940);
  });
});

describe('buildSpotProjectionGrid', () => {
  it('builds 30 minute cells and longer row including EOD', () => {
    const g = buildSpotProjectionGrid({
      spotLast: 90_000,
      slopeUsdPerSec: 2,
      endsInMs: 3_600_000,
    });
    expect(g).not.toBeNull();
    expect(g!.minuteHorizons).toHaveLength(30);
    expect(g!.minuteHorizons[0]!.label).toBe('1m');
    expect(g!.minuteHorizons[0]!.price).toBe(90_000 + 2 * 60);
    expect(g!.minuteHorizons[29]!.label).toBe('30m');
    expect(g!.minuteHorizons[29]!.price).toBe(90_000 + 2 * 30 * 60);

    const labels = g!.longerHorizons.map((c) => c.label);
    expect(labels).toEqual(['5m', '15m', '30m', '1h', 'EOD']);
    const eod = g!.longerHorizons.find((c) => c.label === 'EOD')!;
    expect(eod.horizonSec).toBe(3600);
    expect(eod.price).toBe(90_000 + 2 * 3600);
  });

  it('marks EOD unavailable when endsInMs missing', () => {
    const g = buildSpotProjectionGrid({ spotLast: 50_000, slopeUsdPerSec: 0.1 });
    const eod = g!.longerHorizons.find((c) => c.label === 'EOD')!;
    expect(Number.isNaN(eod.price)).toBe(true);
  });

  it('returns null when inputs invalid', () => {
    expect(buildSpotProjectionGrid({ spotLast: NaN, slopeUsdPerSec: 1 })).toBeNull();
    expect(buildSpotProjectionGrid({ spotLast: 1, slopeUsdPerSec: NaN })).toBeNull();
  });
});
