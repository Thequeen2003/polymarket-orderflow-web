import { describe, expect, it } from 'vitest';
import { computeStableProjectedHeader, quantizeStableUsd } from './chartStableProjectedHeader';

describe('chartStableProjectedHeader', () => {
  it('projects 30s spot from slope', () => {
    const h = computeStableProjectedHeader({
      spotLast: 73_712.6,
      slopeUsdPerSec: 42.55 / 30,
      ptb: 73_670,
      lastProbUp: 0.524,
      lastProbDown: 0.476,
      upLabel: 'UP',
      downLabel: 'DOWN',
    });
    expect(h).not.toBeNull();
    expect(h!.projectedSpotUsd).toBeCloseTo(73_755, 0);
    expect(h!.up.probCents).toBe('52.4¢');
    expect(h!.down.probCents).toBe('47.6¢');
    expect(h!.up.arrow).toBe('↑');
    expect(h!.down.arrow).toBe('↓');
  });

  it('quantizes large USD for stable display', () => {
    expect(quantizeStableUsd(73_712.63)).toBeCloseTo(73_712.65, 2);
    expect(quantizeStableUsd(73_712.2)).toBeCloseTo(73_712.2, 2);
  });
});
