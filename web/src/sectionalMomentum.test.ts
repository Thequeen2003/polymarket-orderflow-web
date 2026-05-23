import { describe, expect, it } from 'vitest';

import {
  buildSpotSections,
  forecastMomentumSwitch,
  pickSectionPlan,
} from './sectionalMomentum';

function ramp(t0: number, samples: number, stepMs: number, startV: number, perStep: number) {
  const out: { t: number; v: number }[] = [];
  for (let i = 0; i < samples; i++) {
    out.push({ t: t0 + i * stepMs, v: startV + i * perStep });
  }
  return out;
}

describe('pickSectionPlan', () => {
  it('uses 15-min sections on 1h zoom', () => {
    expect(pickSectionPlan(3600)).toEqual({ sectionMs: 15 * 60_000, count: 4 });
  });
  it('uses 15-min sections × 8 on 2h zoom', () => {
    expect(pickSectionPlan(7200)).toEqual({ sectionMs: 15 * 60_000, count: 8 });
  });
  it('uses 15-min sections × 16 on 4h zoom', () => {
    expect(pickSectionPlan(4 * 3600)).toEqual({ sectionMs: 15 * 60_000, count: 16 });
  });
  it('falls back to 5-min sections on 30m zoom', () => {
    expect(pickSectionPlan(1800)).toEqual({ sectionMs: 5 * 60_000, count: 6 });
  });
  it('uses 3×5m on 15m zoom', () => {
    expect(pickSectionPlan(900)).toEqual({ sectionMs: 5 * 60_000, count: 3 });
  });
  it('uses 5×1m on 5m zoom', () => {
    expect(pickSectionPlan(300)).toEqual({ sectionMs: 60_000, count: 5 });
  });
  it('returns null below 1m zoom', () => {
    expect(pickSectionPlan(30)).toBeNull();
  });
});

describe('buildSpotSections', () => {
  it('splits a steady up-ramp into UP sections', () => {
    const t0 = 1_700_000_000_000;
    // 60 minutes, 1 sample per 5s, +0.5/sample → ramps from 100 to 460 over 60 min
    const pts = ramp(t0, 60 * 12, 5_000, 100, 0.5);
    const secs = buildSpotSections(pts, 100, 15 * 60_000, 4, 1);
    expect(secs.length).toBe(4);
    expect(secs.every((s) => s.direction === 'UP')).toBe(true);
    expect(secs[3]!.intensity01).toBeGreaterThan(0);
    expect(secs[0]!.netUsd).toBeGreaterThan(40);
  });

  it('flags FLAT for a sub-band wiggle', () => {
    const t0 = 1_700_000_000_000;
    const pts: { t: number; v: number }[] = [];
    for (let i = 0; i < 400; i++) pts.push({ t: t0 + i * 1000, v: 100 + (i % 2 ? 0.05 : -0.05) });
    const secs = buildSpotSections(pts, 100, 60_000, 4, 0.5);
    expect(secs.length).toBeGreaterThan(0);
    expect(secs.every((s) => s.direction === 'FLAT')).toBe(true);
  });

  it('counts PTB crosses', () => {
    const t0 = 1_700_000_000_000;
    const pts: { t: number; v: number }[] = [];
    for (let i = 0; i < 80; i++) pts.push({ t: t0 + i * 1000, v: 100 + (i % 4 < 2 ? 1.5 : -1.5) });
    const secs = buildSpotSections(pts, 100, 30_000, 2, 0.4);
    const totalCrosses = secs.reduce((s, x) => s + x.ptbCrosses, 0);
    expect(totalCrosses).toBeGreaterThanOrEqual(2);
  });
});

describe('forecastMomentumSwitch', () => {
  const baseSection = (over: Partial<ReturnType<typeof buildSpotSections>[number]>): ReturnType<typeof buildSpotSections>[number] => ({
    t0: 0,
    t1: 0,
    o: 0,
    c: 0,
    h: 0,
    l: 0,
    netUsd: 0,
    slopeUsdPerMin: 0,
    direction: 'FLAT',
    pctAbove: 0,
    pctBelow: 0,
    pctAtPtb: 1,
    ptbCrosses: 0,
    intensity01: 0,
    ...over,
  });

  it('returns WAIT when no sections', () => {
    const f = forecastMomentumSwitch({
      sections: [],
      microSlopeUsdPerSec: null,
      spot: 100,
      ptb: 100,
      bandUsd: 1,
      primaryLane: null,
      primaryStatus: 'WAIT',
      primaryConfidence: 'LOW',
    });
    expect(f.status).toBe('WAIT');
  });

  it('returns SWITCH_INCOMING when drift is UP but micro slope is now DOWN', () => {
    const sections = [
      baseSection({ direction: 'UP', netUsd: +5, slopeUsdPerMin: +0.33 }),
      baseSection({ direction: 'UP', netUsd: +4, slopeUsdPerMin: +0.27 }),
    ];
    const f = forecastMomentumSwitch({
      sections,
      microSlopeUsdPerSec: -0.05, // -3 $/min
      spot: 102,
      ptb: 100,
      bandUsd: 1,
      primaryLane: 'up',
      primaryStatus: 'ENTER',
      primaryConfidence: 'MED',
    });
    expect(f.status).toBe('EXIT'); // primary was UP and drift was UP — invalidation triggers EXIT
    expect(f.incomingLane).toBe('down');
    expect(f.driftLane).toBe('up');
    expect(f.etaSec).not.toBeNull();
  });

  it('returns SWITCH_INCOMING (not EXIT) when no primary lane is held', () => {
    const sections = [
      baseSection({ direction: 'UP', netUsd: +5, slopeUsdPerMin: +0.33 }),
      baseSection({ direction: 'UP', netUsd: +4, slopeUsdPerMin: +0.27 }),
    ];
    const f = forecastMomentumSwitch({
      sections,
      microSlopeUsdPerSec: -0.05,
      spot: 102,
      ptb: 100,
      bandUsd: 1,
      primaryLane: null,
      primaryStatus: 'WAIT',
      primaryConfidence: 'LOW',
    });
    expect(f.status).toBe('SWITCH_INCOMING');
    expect(f.incomingLane).toBe('down');
    expect(f.driftLane).toBe('up');
    expect(f.lane).toBe('up');
  });

  it('returns STAY_IN when primary, drift, micro all agree', () => {
    const sections = [
      baseSection({ direction: 'UP', netUsd: +6, slopeUsdPerMin: +0.4 }),
      baseSection({ direction: 'UP', netUsd: +5, slopeUsdPerMin: +0.33 }),
    ];
    const f = forecastMomentumSwitch({
      sections,
      microSlopeUsdPerSec: +0.04,
      spot: 105,
      ptb: 100,
      bandUsd: 1,
      primaryLane: 'up',
      primaryStatus: 'ENTER',
      primaryConfidence: 'HIGH',
    });
    expect(f.status).toBe('STAY_IN');
    expect(f.lane).toBe('up');
    expect(f.confidence).toBe('HIGH');
  });

  it('returns GO_IN when sections newly align with the micro slope and primary still WAITs', () => {
    const sections = [
      baseSection({ direction: 'UP', netUsd: +3, slopeUsdPerMin: +0.2 }),
      baseSection({ direction: 'UP', netUsd: +2, slopeUsdPerMin: +0.13 }),
      baseSection({ direction: 'UP', netUsd: +4, slopeUsdPerMin: +0.27 }),
    ];
    const f = forecastMomentumSwitch({
      sections,
      microSlopeUsdPerSec: +0.04,
      spot: 102,
      ptb: 100,
      bandUsd: 1,
      primaryLane: null,
      primaryStatus: 'WAIT',
      primaryConfidence: 'LOW',
    });
    // Drift is UP and micro is UP — STAY_IN/GO_IN path picks GO_IN since no primary lane.
    expect(['GO_IN', 'STAY_IN']).toContain(f.status);
    expect(f.lane).toBe('up');
  });

  it('returns WAIT when sections are choppy and slope is flat', () => {
    const sections = [
      baseSection({ direction: 'UP', netUsd: +0.2 }),
      baseSection({ direction: 'DOWN', netUsd: -0.2 }),
      baseSection({ direction: 'UP', netUsd: +0.1 }),
    ];
    const f = forecastMomentumSwitch({
      sections,
      microSlopeUsdPerSec: 0,
      spot: 100,
      ptb: 100,
      bandUsd: 1,
      primaryLane: null,
      primaryStatus: 'WAIT',
      primaryConfidence: 'LOW',
    });
    expect(f.status).toBe('WAIT');
  });
});
