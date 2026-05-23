import { describe, expect, it } from 'vitest';

import type { TradeDirective } from './tradeDirective';
import { buildPositionDeskAlerts, computePositionExitReadout } from './positionDeskAlerts';
import type { SwitchForecast } from './sectionalMomentum';

const tapeNeutral = { reliable: false, dominance: 'mixed' as const, netPressure: 0, summary: '—' };

describe('buildPositionDeskAlerts', () => {
  it('surfaces EXIT on held lane from directive and forecast', () => {
    const directive: TradeDirective = {
      action: 'EXIT',
      lane: 'up',
      urgency: 'now',
      recommendedSize: 0,
      headline: 'EXIT UP',
      reason: 'test',
      evidence: [],
      confidence: 'HIGH',
      defensive: true,
      edgePerShareUsd: null,
      laneMid: null,
      laneWinProb: null,
    };
    const forecast: SwitchForecast = {
      status: 'EXIT',
      lane: 'up',
      driftLane: 'up',
      incomingLane: null,
      etaSec: null,
      confidence: 'HIGH',
      headline: 'Exit UP',
      reason: 'sectional',
      evidence: [],
    };
    const a = buildPositionDeskAlerts({
      heldLane: 'up',
      directive,
      forecast,
      tape: tapeNeutral,
      upLabel: 'UP',
      downLabel: 'DOWN',
    });
    expect(a.some((x) => x.kind === 'danger' && x.text.includes('Trade card: EXIT'))).toBe(true);
    expect(a.some((x) => x.text.includes('Sectional EXIT'))).toBe(true);
  });

  it('warns on switch incoming away from held lane', () => {
    const forecast: SwitchForecast = {
      status: 'SWITCH_INCOMING',
      lane: 'up',
      driftLane: 'down',
      incomingLane: 'down',
      etaSec: 12,
      confidence: 'MED',
      headline: 'Switch',
      reason: 'mom',
      evidence: [],
    };
    const a = buildPositionDeskAlerts({
      heldLane: 'up',
      directive: null,
      forecast,
      tape: tapeNeutral,
      upLabel: 'UP',
      downLabel: 'DOWN',
    });
    expect(a[0]?.text).toMatch(/Incoming momentum toward DOWN/);
  });
});

describe('computePositionExitReadout', () => {
  it('returns exit_now when trade card EXIT matches held lane', () => {
    const directive: TradeDirective = {
      action: 'EXIT',
      lane: 'up',
      urgency: 'now',
      recommendedSize: 0,
      headline: 'EXIT UP',
      reason: 'r',
      evidence: [],
      confidence: 'HIGH',
      defensive: true,
      edgePerShareUsd: null,
      laneMid: null,
      laneWinProb: null,
    };
    const r = computePositionExitReadout({
      heldLane: 'up',
      directive,
      forecast: null,
      tape: tapeNeutral,
      upLabel: 'UP',
      downLabel: 'DOWN',
    });
    expect(r.band).toBe('exit_now');
    expect(r.headline).toMatch(/EXIT now/i);
  });

  it('returns hold when exit is on the other lane', () => {
    const directive: TradeDirective = {
      action: 'EXIT',
      lane: 'down',
      urgency: 'now',
      recommendedSize: 0,
      headline: 'EXIT DOWN',
      reason: 'r',
      evidence: [],
      confidence: 'HIGH',
      defensive: true,
      edgePerShareUsd: null,
      laneMid: null,
      laneWinProb: null,
    };
    const r = computePositionExitReadout({
      heldLane: 'up',
      directive,
      forecast: null,
      tape: tapeNeutral,
      upLabel: 'UP',
      downLabel: 'DOWN',
    });
    expect(r.band).toBe('hold');
    expect(r.headline).toMatch(/not UP/i);
  });
});
