import { describe, expect, it } from 'vitest';
import { buildNowPriceBandDistances, buildSpotBandGlance } from './nowPriceSignals';
import { buildNowPriceGlanceSummary } from './nowPriceGlance';
import { evaluateProbabilityEdgeScalp } from './probabilityEdgeScalp';
import { estimateBinaryOutcomeBias } from './binaryOutcomeBias';
import { computeDeskSpeedSnapshot } from './deskSpeedLayers';

describe('buildNowPriceGlanceSummary', () => {
  it('surfaces band, breaks, and NO TRADE when edge is inside band', () => {
    const band = buildNowPriceBandDistances({ now: 70_837.13, ptb: 70_832.23, bandUsd: 5.67 })!;
    const glance = buildSpotBandGlance(band);
    const bias = estimateBinaryOutcomeBias({
      now: band.now,
      ptb: band.ptb,
      spotPts: [
        { t: 0, v: band.now - 20 },
        { t: 30_000, v: band.now },
      ],
      probUp01: 0.296,
      probDown01: 0.525,
      horizonSec: 30,
    });
    const edgeScalp =
      bias != null
        ? evaluateProbabilityEdgeScalp({
            estimate: bias,
            pMkt: 0.296,
            spotPts: [
              { t: 0, v: band.now - 20 },
              { t: 30_000, v: band.now },
            ],
            now: band.now,
            ptb: band.ptb,
            probUpDelta01: -0.18,
            upLabel: 'Up',
            downLabel: 'Down',
          })
        : null;
    const deskSpeed = computeDeskSpeedSnapshot({
      spotPts: [
        { t: 0, v: band.now + 8 },
        { t: 30_000, v: band.now },
      ],
      nowSpot: band.now,
      ptb: band.ptb,
      probUpPts: [
        { t: 0, v: 0.48 },
        { t: 30_000, v: 0.295 },
      ],
      probDownPts: [
        { t: 0, v: 0.52 },
        { t: 30_000, v: 0.703 },
      ],
      pMktUp: 0.296,
      pMktDown: 0.703,
      upLabel: 'Up',
      downLabel: 'Down',
      horizonSec: 30,
    });

    const g = buildNowPriceGlanceSummary({
      band,
      glance,
      upLabel: 'Up',
      downLabel: 'Down',
      edgeScalp,
      fairValueGap: null,
      fvgSignal: null,
      deskSpeed,
      machineReadout: null,
      bandGauge: null,
      physicsLine: 'Signal: Down — drift lane Down',
      probUp01: 0.295,
      probDown01: 0.703,
      probUpDelta01: -0.18,
      probDownDelta01: 0.178,
    });

    expect(g.geo).toBe('IN BAND');
    expect(g.tradeCall).toBe('NO TRADE');
    expect(g.upBreakShort).toContain('below');
    expect(g.downBreakShort).toContain('above');
    expect(g.speedLabel).toContain('Down');
    expect(g.bannerLine).toContain('Signal: Down');
    expect(edgeScalp).not.toBeNull();
    expect(g.edgeLabel).toMatch(/^Edge /);
  });
});
