import { describe, expect, it } from 'vitest';
import { computeSpotBandGaugeSnapshot, resolveDeskPlaybookAction } from './spotBandDeskAction';
import type { OperatorVerdict } from './operatorVerdict';
import type { TradeLevels } from './tradeLevels';

describe('spotBandDeskAction', () => {
  it('confirm phase — short wait, no STEP label', () => {
    const g = computeSpotBandGaugeSnapshot({
      mode: 'down',
      spot: 79_178,
      ptb: 79_178.12,
      band: 6.33,
      conviction: 'CLEAR SEPARATION',
    });
    expect(g?.activeStep).toBe('confirm');
    const desk = resolveDeskPlaybookAction({
      bandGauge: g,
      manualLane: null,
      exitReadout: null,
      verdict: null,
      hasDirective: true,
    });
    expect(desk.primary).toMatch(/WAIT.*confirm break/i);
    expect(desk.primary).not.toMatch(/STEP/i);
  });

  it('in band + GO verdict — steady ENTER (band does not force WAIT)', () => {
    const g = computeSpotBandGaugeSnapshot({
      mode: 'up',
      spot: 100,
      ptb: 100,
      band: 2,
      conviction: 'STRONG SEPARATION',
    });
    expect(g?.activeStep).toBe('confirm');
    const verdict: OperatorVerdict = {
      state: 'GO_LONG',
      color: 'green',
      bigVerb: 'ENTER UP',
      headline: '@ 0.62',
      reason: 'consensus',
      confidence: 'HIGH',
      blockers: [],
      primaryBlocker: null,
      isStandDown: false,
    };
    const desk = resolveDeskPlaybookAction({
      bandGauge: g,
      manualLane: null,
      exitReadout: null,
      verdict,
      hasDirective: true,
      directive: {
        action: 'INITIATE',
        lane: 'up',
        urgency: 'now',
        recommendedSize: 0.4,
        headline: 'INITIATE UP',
        reason: 'r',
        evidence: [],
        confidence: 'HIGH',
        defensive: false,
        edgePerShareUsd: 0.05,
        laneMid: 0.62,
        laneWinProb: 0.58,
      },
    });
    expect(desk.primary).toMatch(/ENTER UP/i);
    expect(desk.primary).not.toMatch(/confirm break/i);
    expect(desk.detail).toMatch(/Confirm \(guide\)/i);
  });

  it('entry phase + card — ENTER with cents', () => {
    const ptb = 79_178.12;
    const band = 6.33;
    const g = computeSpotBandGaugeSnapshot({
      mode: 'down',
      spot: ptb - band * 2.5,
      ptb,
      band,
      conviction: 'STRONG SEPARATION',
    });
    const levels: TradeLevels = {
      lane: 'down',
      entry: 0.41,
      takeProfit: 0.52,
      stopLoss: 0.33,
      takeProfitGain: 0.11,
      stopLossLoss: 0.08,
      rrRatio: 1.38,
      horizonSec: 120,
      summary: 'x',
      collapsed: false,
    };
    const verdict: OperatorVerdict = {
      state: 'GO_SHORT',
      color: 'green',
      bigVerb: 'ENTER DOWN',
      headline: 'x',
      reason: 'r',
      confidence: 'HIGH',
      blockers: [],
      primaryBlocker: null,
      isStandDown: false,
    };
    const desk = resolveDeskPlaybookAction({
      bandGauge: g,
      manualLane: null,
      exitReadout: null,
      verdict,
      hasDirective: true,
      directive: {
        action: 'INITIATE',
        lane: 'down',
        urgency: 'now',
        recommendedSize: 0.4,
        headline: 'INITIATE DOWN',
        reason: 'r',
        evidence: [],
        confidence: 'HIGH',
        defensive: false,
        edgePerShareUsd: 0.05,
        laneMid: 0.41,
        laneWinProb: 0.55,
      },
      levels,
    });
    expect(desk.primary).toBe('ENTER DOWN @ 41¢ · TP 52¢ · SL 33¢');
    expect(desk.primary).toContain('TP 52¢');
  });

  it('does not ENTER from PTB band alone when flow favors the opposite side', () => {
    const ptb = 100_000;
    const band = 50;
    const g = computeSpotBandGaugeSnapshot({
      mode: 'up',
      spot: ptb + band * 2,
      ptb,
      band,
      conviction: 'STRONG SEPARATION',
    });
    expect(g?.geo).toBe('ABOVE');
    const desk = resolveDeskPlaybookAction({
      bandGauge: g,
      manualLane: null,
      exitReadout: null,
      verdict: null,
      hasDirective: true,
      flowWinningLane: 'down',
      bookControl: 'down',
    });
    expect(desk.primary).toMatch(/book\/tape favor/i);
    expect(desk.primary).not.toMatch(/^ENTER UP/i);
  });
});
