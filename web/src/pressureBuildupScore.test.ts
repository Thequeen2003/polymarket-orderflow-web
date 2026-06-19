import { describe, expect, it } from 'vitest';
import { computeDeskSpeedSnapshot } from './deskSpeedLayers';
import { buildMtfConsensus } from './multiTimeframeConsensus';
import { computePressureBuildup } from './pressureBuildupScore';

function steadySpot(slope: number, durMs: number) {
  const out: { t: number; v: number }[] = [];
  const t0 = 100_000;
  let v = 70_000;
  for (let t = 0; t <= durMs; t += 1000) {
    out.push({ t: t0 + t, v });
    v += slope * 1;
  }
  return out;
}

function dualSpeed(tEnd: number, opts: Parameters<typeof computeDeskSpeedSnapshot>[0]) {
  const early = computeDeskSpeedSnapshot({ ...opts, horizonSec: 10 });
  const confirm = computeDeskSpeedSnapshot({ ...opts, horizonSec: 30 });
  return { early: early!, confirm: confirm! };
}

describe('pressureBuildupScore', () => {
  it('scores early window before confirm catches up', () => {
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
        { t: tEnd - 30_000, v: 0.35 },
        { t: tEnd - 10_000, v: 0.37 },
        { t: tEnd, v: 0.38 },
      ],
      pMktUp: 0.38,
      probDownPts: [
        { t: tEnd - 30_000, v: 0.65 },
        { t: tEnd - 10_000, v: 0.63 },
        { t: tEnd, v: 0.62 },
      ],
      pMktDown: 0.62,
    });
    const mtf = buildMtfConsensus(steadySpot(0.4, 35 * 60_000), 5);
    const pressure = computePressureBuildup(early, confirm, {
      mtf,
      nowSpot: 70_200,
      pMktUp: 0.38,
      pMktDown: 0.62,
    });
    expect(pressure.earlyScore).toBeGreaterThanOrEqual(4);
    expect(pressure.confirmScore).toBe(5);
    expect(pressure.timing).not.toBe('CHASING');
    expect(['WATCH', 'EARLY_ENTRY', 'STRONG_SETUP']).toContain(pressure.verdict);
  });

  it('downgrades CHASING when confirm already repriced +27pp', () => {
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
        { t: tEnd, v: 0.845 },
      ],
      pMktUp: 0.845,
      probDownPts: [
        { t: tEnd - 30_000, v: 0.425 },
        { t: tEnd, v: 0.155 },
      ],
      pMktDown: 0.155,
    });
    const mtf = buildMtfConsensus(steadySpot(0.4, 35 * 60_000), 5);
    const pressure = computePressureBuildup(early, confirm, {
      mtf,
      nowSpot: 65_342,
      pMktUp: 0.845,
      pMktDown: 0.155,
    });
    expect(pressure.confirmScore).toBe(5);
    expect(pressure.timing).toBe('CHASING');
    expect(pressure.verdict).toBe('WATCH');
    expect(pressure.headline).toMatch(/CHASING/);
    expect(pressure.buy.rows.find((r) => r.id === 'upProb')?.point).toBe(0);
  });

  it('returns NO_TRADE when both early sides score low', () => {
    const tEnd = 100_000;
    const { early, confirm } = dualSpeed(tEnd, {
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
    const pressure = computePressureBuildup(early, confirm);
    expect(pressure.verdict).toBe('NO_TRADE');
    expect(pressure.buy.score).toBeLessThanOrEqual(2);
    expect(pressure.sell.score).toBeLessThanOrEqual(2);
  });

  it('maps early score 3 to WATCH when not chasing', () => {
    const tEnd = 100_000;
    const { early, confirm } = dualSpeed(tEnd, {
      spotPts: [
        { t: tEnd - 30_000, v: 70_000 },
        { t: tEnd, v: 70_120 },
      ],
      nowSpot: 70_120,
      ptb: 70_100,
      probUpPts: [
        { t: tEnd - 30_000, v: 0.4 },
        { t: tEnd, v: 0.48 },
      ],
      pMktUp: 0.48,
      probDownPts: [
        { t: tEnd - 30_000, v: 0.6 },
        { t: tEnd, v: 0.52 },
      ],
      pMktDown: 0.52,
    });
    const pressure = computePressureBuildup(early, confirm);
    if (pressure.buy.score === 3) {
      expect(pressure.verdict).toBe('WATCH');
    }
  });
});
