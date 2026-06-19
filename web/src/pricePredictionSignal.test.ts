import { describe, expect, it } from 'vitest';

import {
  buildPricePredictionSummary,
  computePricePredictionSignal,
  formatCountdownSec,
  formatHorizonTimeFrame,
  formatProjectionCountdown,
  projectionCountdownSec,
  projectionTargetMs,
  sideVsPtb,
} from './pricePredictionSignal';

describe('pricePredictionSignal', () => {
  it('classifies spot above PTB', () => {
    const r = sideVsPtb(73_800, 73_750);
    expect(r.side).toBe('above');
    expect(r.label).toBe('ABOVE PTB');
    expect(r.distUsd).toBeCloseTo(50, 0);
  });

  it('classifies spot below PTB', () => {
    const r = sideVsPtb(73_700, 73_750);
    expect(r.side).toBe('below');
    expect(r.label).toBe('BELOW PTB');
  });

  it('classifies near PTB as AT', () => {
    const r = sideVsPtb(73_750.2, 73_750, 0.5);
    expect(r.side).toBe('at');
    expect(r.label).toBe('AT PTB');
  });

  it('projects above PTB when slope is positive', () => {
    const sig = computePricePredictionSignal({
      spotUsd: 73_740,
      slopeUsdPerSec: 2,
      ptbUsd: 73_750,
      horizonSec: 30,
      upLabel: 'UP',
      downLabel: 'DOWN',
    });
    expect(sig).not.toBeNull();
    expect(sig!.now.side).toBe('below');
    expect(sig!.projected.side).toBe('above');
    expect(sig!.favoredLane).toBe('up');
    expect(sig!.headline).toContain('ABOVE PTB');
  });

  it('favors DOWN when projected below PTB', () => {
    const sig = computePricePredictionSignal({
      spotUsd: 73_760,
      slopeUsdPerSec: -2,
      ptbUsd: 73_750,
      horizonSec: 30,
    });
    expect(sig!.projected.side).toBe('below');
    expect(sig!.favoredLane).toBe('down');
  });

  it('includes 30s, 1m, and 5m projection horizons', () => {
    const sig = computePricePredictionSignal({
      spotUsd: 63_626.18,
      slopeUsdPerSec: -40 / 30,
      ptbUsd: 63_461.12,
      horizonSec: 30,
    });
    expect(sig!.projections.map((p) => p.label)).toEqual(['30s', '1m', '5m']);
    expect(sig!.projections[0]!.projectedUsd).toBeCloseTo(63_586, 0);
    expect(sig!.projections[1]!.projectedUsd).toBeCloseTo(63_546, 0);
    expect(sig!.projections[2]!.projectedUsd).toBeCloseTo(63_226, -1);
  });

  it('formats horizon timers for prediction boxes', () => {
    const nowMs = 1_700_000_000_000;
    expect(formatHorizonTimeFrame(0)).toBe('Live · now');
    expect(formatHorizonTimeFrame(30)).toBe('30s horizon');
    expect(formatHorizonTimeFrame(300)).toBe('5m horizon');
    expect(projectionCountdownSec(30, nowMs)).toBe(30);
    expect(formatProjectionCountdown(30, nowMs)).toBe('0:30');
    expect(formatProjectionCountdown(60, nowMs)).toBe('1:00');
    expect(formatProjectionCountdown(300, nowMs)).toBe('5:00');
    expect(formatCountdownSec(125)).toBe('2:05');
    expect(projectionTargetMs(60, nowMs)).toBe(nowMs + 60_000);
  });

  it('summary chains now through 30s, 1m, and 5m', () => {
    const sig = computePricePredictionSignal({
      spotUsd: 63_632,
      slopeUsdPerSec: 27 / 30,
      ptbUsd: 63_624.31,
      bandUsd: 0.5,
      horizonSec: 30,
    });
    expect(sig!.summary).toContain('Now ABOVE PTB');
    expect(sig!.summary).toContain('30s ABOVE PTB');
    expect(sig!.summary).toContain('1m ABOVE PTB');
    expect(sig!.summary).toContain('5m ABOVE PTB');
    expect(buildPricePredictionSummary(sig!.now, sig!.projections)).toBe(sig!.summary);
  });
});
