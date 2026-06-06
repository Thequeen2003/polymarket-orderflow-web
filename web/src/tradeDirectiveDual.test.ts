import { describe, expect, it } from 'vitest';
import { buildTradeDirectiveFromDual, type DualEngineCallForDirective } from './tradeDirective';

const goToronto: DualEngineCallForDirective = {
  lane: 'up',
  verdict: 'ENTER',
  gate: 'ARMED',
  enterOnlyIf: 'Dual bucket closed above entry line',
  go: true,
  laneLock: { lane: 'up', status: 'LOCKED', confidence: 'HIGH', reason: 'Momentum aligned' },
};

describe('buildTradeDirectiveFromDual', () => {
  it('INITIATE when flat and dual GO', () => {
    const d = buildTradeDirectiveFromDual(goToronto, {
      currentPositionLane: null,
      upLabel: 'Toronto Blue Jays',
      downLabel: 'Atlanta Braves',
    });
    expect(d.action).toBe('INITIATE');
    expect(d.lane).toBe('up');
    expect(d.laneOutcomeLabel).toBe('TORONTO BLUE JAYS');
  });

  it('STAND_DOWN when dual not GO', () => {
    const d = buildTradeDirectiveFromDual(
      { ...goToronto, go: false, verdict: 'WAIT' },
      { currentPositionLane: null, upLabel: 'Toronto', downLabel: 'Atlanta' },
    );
    expect(d.action).toBe('STAND_DOWN');
  });
});
