import { describe, expect, it } from 'vitest';
import { spreadBracketFromFillPrice01 } from './armRiskFromSignal';
import { buildQuoteAssistTargets, loadEmergencyStopBundlePrefs } from './buyBundleStaging';
import { computePreBuyTpOutlook } from './positionTpOutlook';

describe('NowPrice buy strip TP preview', () => {
  it('estimates pre-buy TP outlook from ask entry and quote-assist TP', () => {
    const entry01 = 0.885;
    const touch = { bestBid: 0.884, bestAsk: 0.885 };
    const prefs = loadEmergencyStopBundlePrefs();
    const tpCents =
      prefs.autoTpOnFill && buildQuoteAssistTargets({ quote01: entry01, ...touch })?.tpCents
        ? buildQuoteAssistTargets({ quote01: entry01, ...touch })!.tpCents
        : spreadBracketFromFillPrice01(entry01, touch).tpCents;

    const outlook = computePreBuyTpOutlook({
      entry01,
      tpCents,
      current01: 0.99,
      probSeries: [{ t: 1, v: 0.88 }, { t: 2, v: 0.95 }, { t: 3, v: 0.99 }],
    });

    expect(outlook).not.toBeNull();
    expect(outlook!.tpCents).toBeGreaterThan(entry01 * 100);
  });
});
