import { describe, expect, it } from 'vitest';
import { computeDeskSpeedSnapshot } from './deskSpeedLayers';
import { computeContractEntryJump, probSpeedDetailWithGain, spotSpeedDetailWithGain } from './deskSpeedGainPct';

describe('deskSpeedGainPct', () => {
  it('spot gain is % of current price', () => {
    const tEnd = 100_000;
    const snap = computeDeskSpeedSnapshot({
      spotPts: [
        { t: tEnd - 30_000, v: 70_000 },
        { t: tEnd, v: 70_150 },
      ],
      nowSpot: 70_150,
      ptb: 70_100,
      probUpPts: [{ t: tEnd, v: 0.5 }],
      pMktUp: 0.5,
    });
    const spot = snap!.spot!;
    const g = spotSpeedDetailWithGain(spot, 70_150, 30);
    expect(g.gainPct).toMatch(/\+0\.21% \/ 30s/);
    expect(g.gainPct).toMatch(/%\/min/);
  });

  it('prob gain includes pp window and % vs mid', () => {
    const tEnd = 100_000;
    const snap = computeDeskSpeedSnapshot({
      spotPts: [
        { t: tEnd - 30_000, v: 70_000 },
        { t: tEnd, v: 70_000 },
      ],
      nowSpot: 70_000,
      ptb: 70_000,
      probUpPts: [
        { t: tEnd - 30_000, v: 0.4 },
        { t: tEnd, v: 0.52 },
      ],
      pMktUp: 0.52,
    });
    const prob = snap!.lanes.up.prob!;
    const g = probSpeedDetailWithGain(prob, 0.52, 30);
    expect(g.gainPct).toContain('pp / 30s');
    expect(g.gainPct).toContain('vs mid');
  });

  it('entry jump from window-open mid to now (e.g. 46¢ → 52¢)', () => {
    const tEnd = 100_000;
    const snap = computeDeskSpeedSnapshot({
      spotPts: [{ t: tEnd - 30_000, v: 70_000 }, { t: tEnd, v: 70_000 }],
      nowSpot: 70_000,
      ptb: 70_000,
      probUpPts: [
        { t: tEnd - 30_000, v: 0.46 },
        { t: tEnd, v: 0.52 },
      ],
      pMktUp: 0.52,
    });
    const jump = computeContractEntryJump({
      prob: snap!.lanes.up.prob,
      now01: 0.52,
      horizonSec: 30,
      outcomeLabel: 'Up',
    });
    expect(jump).not.toBeNull();
    expect(jump!.entry01).toBeCloseTo(0.46, 2);
    expect(jump!.now01).toBeCloseTo(0.52, 2);
    expect(jump!.gainCents).toBeCloseTo(6, 1);
    expect(jump!.headline).toMatch(/46.*→.*52.*now/);
    expect(jump!.headline).toContain('over 30s');
    expect(jump!.projLine).toMatch(/Now 52/);
  });
});
