import { describe, expect, it } from 'vitest';
import {
  computeDeskSpeedSnapshot,
  ptbGapMotion,
  ptbSupportForLane,
  spotSupportForLane,
} from './deskSpeedLayers';

describe('deskSpeedLayers', () => {
  it('v_spot is delta over 30s', () => {
    const tEnd = 100_000;
    const snap = computeDeskSpeedSnapshot({
      spotPts: [
        { t: tEnd - 30_000, v: 70_000 },
        { t: tEnd, v: 70_150 },
      ],
      nowSpot: 70_150,
      ptb: 70_100,
      probUpPts: [{ t: tEnd - 30_000, v: 0.5 }, { t: tEnd, v: 0.55 }],
      pMktUp: 0.55,
      probDownPts: [{ t: tEnd - 30_000, v: 0.5 }, { t: tEnd, v: 0.45 }],
      pMktDown: 0.45,
    });
    expect(snap).not.toBeNull();
    expect(snap!.spot!.delta30).toBeCloseTo(150, 0);
    expect(snap!.spot!.direction).toBe('UP');
    expect(snap!.lanes.up.prob!.id).toBe('probUp');
    expect(snap!.lanes.down.prob!.id).toBe('probDown');
  });

  it('PTB gap toward equilibrium when gap closes', () => {
    expect(ptbGapMotion(100, -50)).toBe('TOWARD_PTB');
    expect(ptbGapMotion(-100, 50)).toBe('TOWARD_PTB');
    expect(ptbGapMotion(-100, -50)).toBe('AWAY_PTB');
  });

  it('spot support splits by lane', () => {
    expect(spotSupportForLane('up', 'DOWN')).toBe('HEADWIND');
    expect(spotSupportForLane('down', 'DOWN')).toBe('TAILWIND');
  });

  it('DOWN lane tailwind when below PTB grinding lower', () => {
    const r = ptbSupportForLane('down', -50, 'AWAY_PTB');
    expect(r.support).toBe('TAILWIND');
  });
});
