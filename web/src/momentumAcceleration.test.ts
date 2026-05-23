import { describe, expect, it } from 'vitest';
import { detectMomentumAcceleration, type AccelTick } from './momentumAcceleration';

function genSegmented(slope1: number, slope2: number, durEachMs = 60_000, stepMs = 1000): AccelTick[] {
  const out: AccelTick[] = [];
  let v = 100;
  const t0 = 1_700_000_000_000;
  for (let t = 0; t <= durEachMs; t += stepMs) {
    out.push({ t: t0 + t, v });
    v += slope1 * (stepMs / 1000);
  }
  // continue with slope2
  const last = out[out.length - 1]!;
  for (let t = stepMs; t <= durEachMs; t += stepMs) {
    out.push({ t: last.t + t, v: last.v + slope2 * (t / 1000) });
  }
  return out;
}

describe('detectMomentumAcceleration', () => {
  it('returns idle when fewer than threshold ticks', () => {
    const r = detectMomentumAcceleration([{ t: 0, v: 100 }]);
    expect(r.state).toBe('idle');
  });

  it('detects accel-up when late slope dominates and matches sign', () => {
    const ticks = genSegmented(0.05, 0.5, 60_000); // early flat-ish, late up fast
    const r = detectMomentumAcceleration(ticks, { lateMs: 60_000, earlyMs: 60_000 });
    expect(r.state).toBe('accel-up');
    expect(r.direction).toBe('up');
    expect(r.thrust).toBeGreaterThan(60);
  });

  it('detects accel-down', () => {
    const ticks = genSegmented(-0.05, -0.6, 60_000);
    const r = detectMomentumAcceleration(ticks, { lateMs: 60_000, earlyMs: 60_000 });
    expect(r.state).toBe('accel-down');
    expect(r.direction).toBe('down');
  });

  it('detects reversing when signs flip', () => {
    const ticks = genSegmented(0.5, -0.5, 60_000);
    const r = detectMomentumAcceleration(ticks, { lateMs: 60_000, earlyMs: 60_000 });
    expect(r.state).toBe('reversing');
  });

  it('detects decel when late slope is much smaller', () => {
    const ticks = genSegmented(0.6, 0.1, 60_000);
    const r = detectMomentumAcceleration(ticks, { lateMs: 60_000, earlyMs: 60_000 });
    expect(r.state).toBe('decel');
  });

  it('reports steady when slopes are tiny on both sides', () => {
    const ticks = genSegmented(0.001, 0.001, 60_000);
    const r = detectMomentumAcceleration(ticks, { lateMs: 60_000, earlyMs: 60_000 });
    expect(r.state).toBe('steady');
  });
});
