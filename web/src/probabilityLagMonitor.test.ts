import { describe, expect, it } from 'vitest';
import {
  appendPlmSample,
  buildPlmReplayLine,
  detectPlmRepricingEvents,
  computePlmLiveStats,
  type PlmSample,
} from './probabilityLagMonitor';

function mkSamples(count: number, baseMs: number, edgeFn: (i: number) => number): PlmSample[] {
  return Array.from({ length: count }, (_, i) => {
    const edge = edgeFn(i) / 100;
    const pMkt = 0.92;
    return {
      t: baseMs + i * 1000,
      pMkt,
      pModel: pMkt + edge,
      edge,
    };
  });
}

describe('probabilityLagMonitor', () => {
  it('appendPlmSample caps buffer', () => {
    let s: PlmSample[] = [];
    for (let i = 0; i < 5; i++) {
      s = appendPlmSample(s, { t: i, pMkt: 0.5, pModel: 0.55, edge: 0.05 }, 3);
    }
    expect(s).toHaveLength(3);
  });

  it('detects repricing when mid catches up after positive edge', () => {
    const t0 = 1_000_000;
    const samples: PlmSample[] = [];
    for (let i = 0; i < 55; i++) {
      let pMkt = 0.9;
      let edge = 0.01;
      if (i === 20) edge = 0.06;
      if (i >= 50) {
        pMkt = 0.935;
        edge = 0.005;
      }
      samples.push({ t: t0 + i * 1000, pMkt, pModel: pMkt + edge, edge });
    }

    const events = detectPlmRepricingEvents(samples, { cooldownMs: 5000 });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.caught)).toBe(true);
  });

  it('buildPlmReplayLine uses ages from now', () => {
    const line = buildPlmReplayLine({
      nowMs: 100_000,
      signalAtMs: 55_000,
      observeAtMs: 90_000,
      edgePp: 6,
      repricePp: 5,
    });
    expect(line).toContain('T−45s');
    expect(line).toContain('T−10s');
    expect(line).toContain('+6.0pp');
  });

  it('computePlmLiveStats aggregates catch rate', () => {
    const samples = mkSamples(40, Date.now() - 40_000, () => 2);
    const events = detectPlmRepricingEvents(samples);
    const stats = computePlmLiveStats(samples, events);
    expect(stats.sampleCount).toBe(40);
  });
});
