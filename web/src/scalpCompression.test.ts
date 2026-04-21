import { describe, expect, it } from 'vitest';
import type { ProbMicrostructure } from './ptbAdvancedContext';
import type { EnterBlockReason } from './ptbDecisionEngine';
import { computeScalpCompression4cUp } from './scalpCompression';

function micro(over: Partial<ProbMicrostructure> = {}): ProbMicrostructure {
  return {
    jumpRisk01: 0.2,
    maxBucketJumpCents: 2,
    takeoverRisk: 'low',
    spreadNarrowing: false,
    bothLegsChaotic: false,
    whipsawLeader: false,
    leaderLane: 'up',
    slopeCentsUp: 1,
    slopeCentsDown: -0.5,
    summaryLines: [],
    ...over,
  };
}

function base5of5() {
  return {
    primaryLane: 'up' as const,
    throughLine: true,
    setupReady: true,
    line: 0.52 as number | null,
    speedLabel: 'FAST' as const,
    speedScore01: 0.85,
    net4cRoom: 'YES' as const,
    followThroughConfirm: true,
    enterBlockReason: null as EnterBlockReason,
    microstructure: micro(),
  };
}

describe('computeScalpCompression4cUp', () => {
  it('WAIT when any hard veto fires (NO room)', () => {
    const r = computeScalpCompression4cUp({
      ...base5of5(),
      net4cRoom: 'NO',
    });
    expect(r.state).toBe('WAIT');
    expect(r.vetoes.some((v) => v.id === 'net4c')).toBe(true);
  });

  it('WAIT when MARGINAL +4¢ room (hard veto)', () => {
    const r = computeScalpCompression4cUp({
      ...base5of5(),
      net4cRoom: 'MARGINAL',
    });
    expect(r.state).toBe('WAIT');
    expect(r.vetoes.some((v) => v.id === 'net4c_marginal')).toBe(true);
  });

  it('WAIT when dual_lane_tight veto', () => {
    const r = computeScalpCompression4cUp({
      ...base5of5(),
      enterBlockReason: 'dual_lane_tight',
    });
    expect(r.state).toBe('WAIT');
    expect(r.vetoes.some((v) => v.id === 'dual_lane')).toBe(true);
  });

  it('WAIT when bothLegsChaotic veto', () => {
    const r = computeScalpCompression4cUp({
      ...base5of5(),
      microstructure: micro({ bothLegsChaotic: true }),
    });
    expect(r.state).toBe('WAIT');
  });

  it('WAIT when jump risk at/above scalp ceiling', () => {
    const r = computeScalpCompression4cUp({
      ...base5of5(),
      microstructure: micro({ jumpRisk01: 0.63 }),
    });
    expect(r.state).toBe('WAIT');
    expect(r.vetoes.some((v) => v.id === 'jump')).toBe(true);
  });

  it('WAIT when whipsaw leader and tape not FAST', () => {
    const r = computeScalpCompression4cUp({
      ...base5of5(),
      speedLabel: 'MED',
      speedScore01: 0.7,
      microstructure: micro({ whipsawLeader: true }),
    });
    expect(r.state).toBe('WAIT');
    expect(r.vetoes.some((v) => v.id === 'whipsaw')).toBe(true);
  });

  it('tape does not pass on SLOW even with high speed score', () => {
    const r = computeScalpCompression4cUp({
      ...base5of5(),
      speedLabel: 'SLOW',
      speedScore01: 0.95,
    });
    expect(r.checks.find((c) => c.id === 'tape')?.pass).toBe(false);
  });

  it('WAIT when fewer than 4 checks pass (3/5)', () => {
    const r = computeScalpCompression4cUp({
      ...base5of5(),
      setupReady: false,
      line: null,
      throughLine: false,
      followThroughConfirm: false,
      net4cRoom: 'YES',
    });
    expect(r.passCount).toBeLessThan(4);
    expect(r.state).toBe('WAIT');
  });

  it('ARMED at 4/5 with no veto (not through break yet)', () => {
    const r = computeScalpCompression4cUp({
      ...base5of5(),
      throughLine: false,
    });
    expect(r.passCount).toBe(4);
    expect(r.vetoes).toHaveLength(0);
    expect(r.state).toBe('ARMED');
  });

  it('ENTER at 5/5 with through break + clean gates', () => {
    const r = computeScalpCompression4cUp(base5of5());
    expect(r.passCount).toBe(5);
    expect(r.state).toBe('ENTER');
  });
});
