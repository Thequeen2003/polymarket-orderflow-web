import { describe, expect, it } from 'vitest';
import { buildPocketOptionMomentumReadout } from './pocketOptionDesk';
import type { BinaryPrediction } from './binaryCandlePredictor';

function pred(direction: 'up' | 'down', confidencePct: number): BinaryPrediction {
  const probUp = direction === 'up' ? 0.5 + confidencePct / 200 : 0.5 - confidencePct / 200;
  return {
    direction,
    probUp,
    confidencePct,
    score: direction === 'up' ? 1 : -1,
    reasons: direction === 'up' ? ['Live bar printing green vs its open.'] : ['Live bar printing red vs its open.'],
    strikePrice: 100_000,
    expiresAtMs: Date.now() + 60_000,
  };
}

describe('buildPocketOptionMomentumReadout', () => {
  it('surfaces CALL on early bucket with strong lean', () => {
    const nowMs = 1_000_000;
    const step = 60_000;
    const bucketStart = Math.floor(nowMs / step) * step;
    const earlyNow = bucketStart + step * 0.15;

    const r = buildPocketOptionMomentumReadout({
      prediction: pred('up', 72),
      expirySec: 60,
      nowMs: earlyNow,
      livePrice: 100_050,
      strikePrice: 100_000,
      buyVolRecent: 10,
      sellVolRecent: 2,
    });
    expect(r.side).toBe('call');
    expect(r.timing).toBe('early');
    expect(r.headline).toContain('CALL');
  });

  it('warns late in bucket', () => {
    const nowMs = 2_000_000;
    const step = 60_000;
    const bucketStart = Math.floor(nowMs / step) * step;
    const lateNow = bucketStart + step * 0.9;

    const r = buildPocketOptionMomentumReadout({
      prediction: pred('down', 65),
      expirySec: 60,
      nowMs: lateNow,
      livePrice: 99_950,
      strikePrice: 100_000,
      buyVolRecent: 1,
      sellVolRecent: 12,
    });
    expect(r.side).toBe('put');
    expect(r.timing).toBe('late');
    expect(r.canTrade).toBe(false);
  });
});
