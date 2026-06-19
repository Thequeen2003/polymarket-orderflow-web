import { describe, expect, it } from 'vitest';
import { computeDeskSpeedSnapshot } from './deskSpeedLayers';
import { computeContractEntryJump } from './deskSpeedGainPct';
import { classifyPressureTiming, probPressurePointEarly } from './pressureTiming';

describe('pressureTiming', () => {
  it('probPressurePointEarly caps large repricing moves', () => {
    expect(probPressurePointEarly({ direction: 'UP', delta30: 0.05 }, 'UP')).toBe(true);
    expect(probPressurePointEarly({ direction: 'UP', delta30: 0.27 }, 'UP')).toBe(false);
  });

  it('classifies CHASING when confirm window repriced heavily', () => {
    const tEnd = 100_000;
    const confirm = computeDeskSpeedSnapshot({
      spotPts: [
        { t: tEnd - 30_000, v: 65_207 },
        { t: tEnd, v: 65_342 },
      ],
      nowSpot: 65_342,
      ptb: 65_350,
      probUpPts: [
        { t: tEnd - 30_000, v: 0.575 },
        { t: tEnd, v: 0.845 },
      ],
      pMktUp: 0.845,
      probDownPts: [
        { t: tEnd - 30_000, v: 0.425 },
        { t: tEnd, v: 0.155 },
      ],
      pMktDown: 0.155,
      horizonSec: 30,
    });
    expect(confirm).not.toBeNull();
    const entryJump = computeContractEntryJump({
      prob: confirm!.lanes.up.prob,
      now01: 0.845,
      horizonSec: 30,
      outcomeLabel: 'Up',
    });
    const readout = classifyPressureTiming({ confirm: confirm!, bias: 'BUY', entryJump });
    expect(readout.timing).toBe('CHASING');
    expect(readout.maxVerdict).toBe('WATCH');
  });

  it('classifies +5¢ / 7.4% confirm move as too late (user scalp threshold)', () => {
    const jump = computeContractEntryJump({
      prob: { direction: 'UP', delta30: 0.05, velocityPerSec: 0.05 / 30, velocityPerMin: 0.1 },
      now01: 0.725,
      horizonSec: 30,
      outcomeLabel: 'Up',
    });
    expect(jump).not.toBeNull();
    expect(jump!.gainCents).toBeCloseTo(5, 1);
    expect(jump!.gainPct).toBeCloseTo(7.4, 0);

    const confirm = computeDeskSpeedSnapshot({
      spotPts: [{ t: 0, v: 70_000 }, { t: 30_000, v: 70_000 }],
      nowSpot: 70_000,
      ptb: 70_000,
      probUpPts: [
        { t: 0, v: 0.675 },
        { t: 30_000, v: 0.725 },
      ],
      pMktUp: 0.725,
      probDownPts: [
        { t: 0, v: 0.325 },
        { t: 30_000, v: 0.275 },
      ],
      pMktDown: 0.275,
      horizonSec: 30,
    });
    const readout = classifyPressureTiming({ confirm: confirm!, bias: 'BUY', entryJump: jump });
    expect(readout.timing).toBe('CHASING');
    expect(readout.note).toMatch(/Too late/i);
  });
});
