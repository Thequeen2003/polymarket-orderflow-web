import { describe, expect, it } from 'vitest';
import { build30DayHourlySpotProjections, PROJECTION_HOURS_30D } from './spotPriceProjection30d';

describe('build30DayHourlySpotProjections', () => {
  const nowMs = Date.UTC(2026, 5, 12, 12, 0, 0);

  it('builds 720 hourly rows for 30 days', () => {
    const g = build30DayHourlySpotProjections({
      spotLast: 100_000,
      slopeUsdPerSec: 1,
      nowMs,
      ptbUsd: 99_500,
    });
    expect(g).not.toBeNull();
    expect(g!.hourlyRows).toHaveLength(PROJECTION_HOURS_30D);
    expect(g!.dailySummaries).toHaveLength(30);
    expect(g!.hourlyRows[0]!.price).toBe(100_000 + 3600);
    expect(g!.hourlyRows[23]!.dayIndex).toBe(1);
    expect(g!.hourlyRows[24]!.dayIndex).toBe(2);
  });

  it('summarizes daily high/low', () => {
    const g = build30DayHourlySpotProjections({
      spotLast: 50_000,
      slopeUsdPerSec: 10,
      nowMs,
      hourCount: 48,
    });
    const day1 = g!.dailySummaries.find((d) => d.dayIndex === 1)!;
    expect(day1.hourCount).toBe(24);
    expect(day1.highPrice).toBeGreaterThan(day1.openPrice);
    expect(day1.closePrice).toBeGreaterThan(day1.openPrice);
  });

  it('returns null for invalid inputs', () => {
    expect(build30DayHourlySpotProjections({ spotLast: NaN, slopeUsdPerSec: 1 })).toBeNull();
  });
});
