import { describe, expect, it } from 'vitest';
import { computeDeskSingleAction } from './deskSingleAction';
import { computeSpotBandGaugeSnapshot } from './spotBandDeskAction';
import type { OperatorVerdict } from './operatorVerdict';
import type { PositionExitReadout } from './positionDeskAlerts';
import type { TradeLevels } from './tradeLevels';

describe('computeDeskSingleAction', () => {
  it('syncing when no directive and flat', () => {
    const r = computeDeskSingleAction({
      manualLane: null,
      exitReadout: null,
      verdict: null,
      hasDirective: false,
    });
    expect(r.primary).toMatch(/WAIT.*syncing/i);
    expect(r.tone).toBe('gray');
  });

  it('in band: still shows ENTER when trade card GO aligns with view', () => {
    const g = computeSpotBandGaugeSnapshot({
      mode: 'up',
      spot: 100,
      ptb: 100,
      band: 2,
      conviction: 'STRONG SEPARATION',
    });
    const v: OperatorVerdict = {
      state: 'GO_LONG',
      color: 'green',
      bigVerb: 'ENTER UP',
      headline: '@ 0.62',
      reason: 'edge',
      confidence: 'HIGH',
      blockers: [],
      primaryBlocker: null,
      isStandDown: false,
    };
    const r = computeDeskSingleAction({
      manualLane: null,
      exitReadout: null,
      verdict: v,
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
      bandGauge: g,
    });
    expect(r.primary).toMatch(/ENTER UP/i);
    expect(r.primary).toMatch(/62/);
    expect(r.tone).toBe('green');
  });

  it('edge live: ENTER + TP/SL cents', () => {
    const levels: TradeLevels = {
      lane: 'down',
      entry: 0.41,
      takeProfit: 0.52,
      stopLoss: 0.33,
      takeProfitGain: 0.11,
      stopLossLoss: 0.08,
      rrRatio: 1.38,
      horizonSec: 120,
      summary: 'test',
      collapsed: false,
    };
    const g = computeSpotBandGaugeSnapshot({
      mode: 'down',
      spot: 79_178.12 - 6.33 * 2.5,
      ptb: 79_178.12,
      band: 6.33,
      conviction: 'STRONG SEPARATION',
    });
    const v: OperatorVerdict = {
      state: 'GO_SHORT',
      color: 'green',
      bigVerb: 'ENTER DOWN',
      headline: '@ 0.41',
      reason: 'edge',
      confidence: 'HIGH',
      blockers: [],
      primaryBlocker: null,
      isStandDown: false,
    };
    const r = computeDeskSingleAction({
      manualLane: null,
      exitReadout: null,
      verdict: v,
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
      bandGauge: g,
    });
    expect(r.primary).toBe('ENTER DOWN @ 41¢ · TP 52¢ · SL 33¢');
  });

  it('uses exit readout when positioned', () => {
    const exit: PositionExitReadout = {
      band: 'exit_now',
      headline: 'EXIT now — trade card is exiting Up.',
      detail: 'd',
    };
    const r = computeDeskSingleAction({
      manualLane: 'up',
      exitReadout: exit,
      verdict: null,
      hasDirective: true,
    });
    expect(r.primary).toContain('EXIT now');
    expect(r.tone).toBe('rose');
  });
});
