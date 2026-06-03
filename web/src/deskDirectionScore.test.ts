import { describe, expect, it } from 'vitest';
import { computeDeskSpeedSnapshot } from './deskSpeedLayers';
import { computeDirectionScore } from './deskDirectionScore';

describe('deskDirectionScore', () => {
  it('scores 4/4 STRONG UP when all layers align bullish', () => {
    const tEnd = 100_000;
    const snap = computeDeskSpeedSnapshot({
      spotPts: [
        { t: tEnd - 30_000, v: 70_000 },
        { t: tEnd, v: 70_150 },
      ],
      nowSpot: 70_150,
      ptb: 70_200,
      probUpPts: [
        { t: tEnd - 30_000, v: 0.4 },
        { t: tEnd, v: 0.55 },
      ],
      pMktUp: 0.55,
      probDownPts: [
        { t: tEnd - 30_000, v: 0.6 },
        { t: tEnd, v: 0.45 },
      ],
      pMktDown: 0.45,
    });
    expect(snap).not.toBeNull();
    const score = computeDirectionScore(snap!, 'UP', 'DOWN');
    expect(score.up.score).toBe(4);
    expect(score.verdict).toBe('STRONG_UP');
    expect(score.headline).toBe('STRONG UP');
    expect(score.activeBullets).toEqual([
      'Spot accelerating higher',
      'Reverting toward PTB',
      'UP probability increasing',
      'DOWN probability decreasing',
    ]);
  });

  it('returns NO TRADE when all UP signals are flat', () => {
    const tEnd = 100_000;
    const snap = computeDeskSpeedSnapshot({
      spotPts: [
        { t: tEnd - 30_000, v: 70_000 },
        { t: tEnd, v: 70_001 },
      ],
      nowSpot: 70_001,
      ptb: 70_000,
      probUpPts: [
        { t: tEnd - 30_000, v: 0.5 },
        { t: tEnd, v: 0.50001 },
      ],
      pMktUp: 0.50001,
      probDownPts: [
        { t: tEnd - 30_000, v: 0.5 },
        { t: tEnd, v: 0.49999 },
      ],
      pMktDown: 0.49999,
    });
    expect(snap).not.toBeNull();
    const score = computeDirectionScore(snap!);
    expect(score.up.score).toBeLessThanOrEqual(1);
  });
});
