import { describe, expect, it } from 'vitest';
import { buildOutcomeMomentumXs } from './bracketMomentumReadout';

describe('buildOutcomeMomentumXs', () => {
  it('returns rising momentum for upward 15s drift', () => {
    const t0 = 1_000_000;
    const pts = [
      { t: t0, v: 0.5 },
      { t: t0 + 5_000, v: 0.52 },
      { t: t0 + 15_000, v: 0.55 },
    ];
    const m = buildOutcomeMomentumXs(pts);
    expect(m).not.toBeNull();
    expect(m!.tone).toBe('up');
    expect(m!.arrow).toBe('↑');
    expect(m!.deltaLabel).toBe('+5.00¢');
    expect(m!.speedLabel).toMatch(/¢\/s$/);
  });

  it('returns null when series is too short', () => {
    expect(buildOutcomeMomentumXs([{ t: 1, v: 0.5 }])).toBeNull();
    expect(buildOutcomeMomentumXs(null)).toBeNull();
  });
});
