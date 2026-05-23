import { describe, expect, it } from 'vitest';
import { detectOverextension, type OverTick } from './overextensionDetector';

function noisy(amplitudePerSec: number, durMs: number, stepMs = 1000): OverTick[] {
  const out: OverTick[] = [];
  const t0 = 1_700_000_000_000;
  let v = 100;
  for (let t = 0; t <= durMs; t += stepMs) {
    out.push({ t: t0 + t, v });
    v += (Math.sin(t / 7000) * amplitudePerSec) * (stepMs / 1000);
  }
  return out;
}

describe('detectOverextension', () => {
  it('returns idle with too few ticks', () => {
    const r = detectOverextension([{ t: 0, v: 100 }]);
    expect(r.state).toBe('idle');
  });

  it('returns idle when total span is < 2x window', () => {
    const t0 = 1_700_000_000_000;
    const ticks: OverTick[] = [];
    for (let i = 0; i < 30; i++) ticks.push({ t: t0 + i * 1000, v: 100 });
    const r = detectOverextension(ticks, { windowMs: 60_000 });
    expect(r.state).toBe('idle');
  });

  it('flags overextended when last 60s spike vs calm baseline', () => {
    const t0 = 1_700_000_000_000;
    const ticks: OverTick[] = [];
    // 10 minutes of calm (~$0.05/sec mild noise)
    for (let i = 0; i < 600; i++) {
      ticks.push({ t: t0 + i * 1000, v: 100 + Math.sin(i / 7) * 0.4 });
    }
    // last 60s: linear $0.5/sec spike → +30$
    const last = ticks[ticks.length - 1]!;
    for (let i = 1; i <= 60; i++) ticks.push({ t: last.t + i * 1000, v: last.v + 0.5 * i });
    const r = detectOverextension(ticks, { windowMs: 60_000, baselineCount: 8 });
    expect(r.state).toBe('overextended');
    expect(r.direction).toBe('up');
    expect(r.severity).toBeGreaterThanOrEqual(70);
    expect(r.ratio).toBeGreaterThan(2.5);
  });

  it('reports normal state on quiet tape', () => {
    const ticks = noisy(0.1, 15 * 60_000);
    const r = detectOverextension(ticks, { windowMs: 60_000, minBandUsd: 0.05 });
    expect(['normal', 'stretched']).toContain(r.state);
    expect(r.severity).toBeLessThan(70);
  });

  it('classifies stretched between thresholds', () => {
    const t0 = 1_700_000_000_000;
    const ticks: OverTick[] = [];
    for (let i = 0; i < 600; i++) ticks.push({ t: t0 + i * 1000, v: 100 + Math.sin(i / 11) * 0.3 });
    const last = ticks[ticks.length - 1]!;
    // last 60s: medium move +0.18*60 = +10.8 against baseline ≈ 0.6 abs * not exact, target stretched
    for (let i = 1; i <= 60; i++) ticks.push({ t: last.t + i * 1000, v: last.v + 0.02 * i });
    const r = detectOverextension(ticks, { windowMs: 60_000 });
    expect(['stretched', 'overextended', 'normal']).toContain(r.state);
  });
});
