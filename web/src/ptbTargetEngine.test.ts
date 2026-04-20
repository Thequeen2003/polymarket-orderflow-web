import { describe, expect, it } from 'vitest';
import { computePtbTargetEngine } from './ptbTargetEngine';

const flat = (p: number, n = 14) => Array.from({ length: n }, () => p);

describe('computePtbTargetEngine', () => {
  const base = {
    lastU: 0.27,
    lastD: 0.73,
    upRising: false,
    dnRising: true,
    gapU: null,
    gapD: {
      lo: 0.7,
      hi: 0.82,
      strength10: 6.5,
      active: true,
      exitWall: 0.83,
    },
    speedLabel: 'FAST' as const,
    speedScore01: 0.78,
    closesUp: flat(0.27),
    closesDown: flat(0.73),
    breakUp: null,
    breakDown: 0.78,
    pressureUp: false,
    pressureDown: true,
    bookUp: {},
    bookDown: {},
  };

  it('picks DOWN leg when it leads and projects forward with gap + wall', () => {
    const t = computePtbTargetEngine(base);
    expect(t.side).toBe('DOWN');
    expect(t.nowLabel).toBe('73¢');
    expect(t.momentum).toBe('Strong');
    expect(t.firstWallLabel).toBe('83¢');
    expect(['Low', 'Medium']).toContain(t.reversalRisk);
    expect(t.nextTargetLabel).toMatch(/^\d+(\.\d)?¢$/);
    expect(t.targetRangeLabel).toMatch(/¢[\u2013-]\d+(\.\d)?¢$/);
    expect(t.engineLane).toBe('down');
    expect(t.next01).toBeGreaterThan(0);
    expect(t.next01).toBeLessThanOrEqual(1);
  });

  it('weak momentum yields tighter next target and higher reversal risk', () => {
    const t = computePtbTargetEngine({
      ...base,
      speedLabel: 'SLOW',
      speedScore01: 0.2,
      dnRising: false,
      gapD: { ...base.gapD!, active: false },
      pressureDown: false,
    });
    expect(t.momentum).toBe('Weak');
    expect(t.reversalRisk).toMatch(/Medium|High/);
  });
});
