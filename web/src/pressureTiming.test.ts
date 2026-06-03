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
});
