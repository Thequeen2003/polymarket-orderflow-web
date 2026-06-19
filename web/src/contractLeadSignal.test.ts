import { describe, expect, it } from 'vitest';
import { computeDeskSpeedSnapshot } from './deskSpeedLayers';
import { computePressureBuildup } from './pressureBuildupScore';
import { computeContractLeadSignal } from './contractLeadSignal';

function dualSpeed(tEnd: number, opts: Parameters<typeof computeDeskSpeedSnapshot>[0]) {
  const early = computeDeskSpeedSnapshot({ ...opts, horizonSec: 10 });
  const confirm = computeDeskSpeedSnapshot({ ...opts, horizonSec: 30 });
  return { early: early!, confirm: confirm! };
}

describe('contractLeadSignal', () => {
  it('hides +1¢ / 30s chop with no spot lead (user case)', () => {
    const tEnd = 100_000;
    const { early, confirm } = dualSpeed(tEnd, {
      spotPts: [
        { t: tEnd - 30_000, v: 70_000 },
        { t: tEnd, v: 70_000 },
      ],
      nowSpot: 70_000,
      ptb: 70_000,
      probUpPts: [
        { t: tEnd - 30_000, v: 0.525 },
        { t: tEnd, v: 0.515 },
      ],
      pMktUp: 0.515,
      probDownPts: [
        { t: tEnd - 30_000, v: 0.475 },
        { t: tEnd, v: 0.485 },
      ],
      pMktDown: 0.485,
    });
    const pressure = computePressureBuildup(early, confirm, {
      nowSpot: 70_000,
      pMktUp: 0.515,
      pMktDown: 0.485,
      downLabel: 'Down',
      upLabel: 'Up',
    });
    expect(pressure.contractLead).toBeNull();
    expect(computeContractLeadSignal(pressure)).toBeNull();
  });

  it('SKIP when confirm already repriced +5¢ (chasing)', () => {
    const tEnd = 100_000;
    const { early, confirm } = dualSpeed(tEnd, {
      spotPts: [
        { t: tEnd - 30_000, v: 65_207 },
        { t: tEnd, v: 65_342 },
      ],
      nowSpot: 65_342,
      ptb: 65_350,
      probUpPts: [
        { t: tEnd - 30_000, v: 0.575 },
        { t: tEnd, v: 0.725 },
      ],
      pMktUp: 0.725,
      probDownPts: [
        { t: tEnd - 30_000, v: 0.425 },
        { t: tEnd, v: 0.275 },
      ],
      pMktDown: 0.275,
    });
    const pressure = computePressureBuildup(early, confirm, {
      nowSpot: 65_342,
      pMktUp: 0.725,
      pMktDown: 0.275,
    });
    expect(pressure.timing).toBe('CHASING');
    expect(pressure.contractLead?.phase).toBe('SKIP');
    expect(pressure.contractLead?.title).toMatch(/Do not chase/i);
    expect(pressure.contractLead?.actionLine).toMatch(/repriced/i);
  });

  it('ENTER on spot-led early window before contract catches up', () => {
    const tEnd = 100_000;
    const { early, confirm } = dualSpeed(tEnd, {
      spotPts: [
        { t: tEnd - 30_000, v: 70_000 },
        { t: tEnd - 10_000, v: 70_020 },
        { t: tEnd, v: 70_180 },
      ],
      nowSpot: 70_180,
      ptb: 70_250,
      probUpPts: [
        { t: tEnd - 30_000, v: 0.35 },
        { t: tEnd - 10_000, v: 0.36 },
        { t: tEnd, v: 0.365 },
      ],
      pMktUp: 0.365,
      probDownPts: [
        { t: tEnd - 30_000, v: 0.65 },
        { t: tEnd - 10_000, v: 0.64 },
        { t: tEnd, v: 0.635 },
      ],
      pMktDown: 0.635,
    });
    const pressure = computePressureBuildup(early, confirm, {
      nowSpot: 70_180,
      pMktUp: 0.365,
      pMktDown: 0.635,
    });
    expect(pressure.leadNote).not.toBeNull();
    expect(pressure.contractLead?.phase).toBe('ENTER');
    expect(pressure.contractLead?.title).toMatch(/Enter/i);
    expect(pressure.contractLead?.actionLine).toMatch(/Spot leading/i);
  });

  it('ENTER when pressure score 4+ with spot and prob aligned (confirm still early)', () => {
    const tEnd = 100_000;
    const { early, confirm } = dualSpeed(tEnd, {
      spotPts: [
        { t: tEnd - 30_000, v: 70_000 },
        { t: tEnd - 10_000, v: 70_050 },
        { t: tEnd, v: 70_200 },
      ],
      nowSpot: 70_200,
      ptb: 70_250,
      probUpPts: [
        { t: tEnd - 30_000, v: 0.5 },
        { t: tEnd - 10_000, v: 0.51 },
        { t: tEnd, v: 0.52 },
      ],
      pMktUp: 0.52,
      probDownPts: [
        { t: tEnd - 30_000, v: 0.5 },
        { t: tEnd - 10_000, v: 0.49 },
        { t: tEnd, v: 0.48 },
      ],
      pMktDown: 0.48,
    });
    const pressure = computePressureBuildup(early, confirm, {
      nowSpot: 70_200,
      pMktUp: 0.52,
      pMktDown: 0.48,
    });
    expect(pressure.timing).not.toBe('CHASING');
    expect(pressure.earlyScore).toBeGreaterThanOrEqual(4);
    expect(pressure.contractLead?.phase).toBe('ENTER');
    expect(pressure.contractLead?.actionLine).toMatch(/Spot leading|10s:/);
  });
});
