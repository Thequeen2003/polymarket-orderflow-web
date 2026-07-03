import { describe, expect, it } from 'vitest';
import { computeDualPtbBattleDesk, spreadLabelFromCents } from './dualPtbBattleMetrics';
import type { PtbTargetEngineCard } from './ptbTargetEngine';

const ptbTarget: PtbTargetEngineCard = {
  side: 'DOWN',
  nowLabel: '55.5¢',
  momentum: 'Medium',
  nextTargetLabel: '57.4¢',
  targetRangeLabel: '56–58¢',
  firstWallLabel: '60¢',
  reversalRisk: 'High',
  summaryLine: 'test',
  engineLane: 'down',
  next01: 0.574,
  lo01: 0.56,
  hi01: 0.58,
  wall01: 0.6,
};

describe('dualPtbBattleDesk', () => {
  it('labels spread tiers', () => {
    expect(spreadLabelFromCents(2)).toBe('Noise');
    expect(spreadLabelFromCents(5)).toBe('Lean');
    expect(spreadLabelFromCents(9)).toBe('Strong');
    expect(spreadLabelFromCents(14)).toBe('Dominant');
  });

  it('picks down bias when down mid dominates', () => {
    const desk = computeDualPtbBattleDesk({
      lastU: 0.43,
      lastD: 0.57,
      upRising: false,
      dnRising: true,
      upSpeedCentsPerMin: -1.2,
      downSpeedCentsPerMin: 2.8,
      pathUpActive: false,
      pathDnActive: true,
      gapUpActive: false,
      gapDownActive: true,
      upReady: false,
      downReady: true,
      displayVerdict: 'ENTER',
      gateArmed: true,
      goNoGo: true,
      laneLockLane: 'down',
      laneLockConfidence: 'HIGH',
      primaryLane: 'down',
      edgeScore: 7.2,
      ptbTarget,
    });
    expect(desk.bias).toBe('down');
    expect(desk.winningLane).toBe('down');
    expect(desk.tradeScoreDown).toBeGreaterThan(desk.tradeScoreUp);
    expect(desk.spreadCents).toBeCloseTo(14, 0);
  });
});
