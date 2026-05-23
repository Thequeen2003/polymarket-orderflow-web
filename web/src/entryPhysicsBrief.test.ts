import { describe, expect, it } from 'vitest';
import {
  buildEntryPhysicsBrief,
  buildExitPhysicsBrief,
  buildTakeSignalPhysicsHint,
  buildTradePhysicsBlocks,
  spotGeometricWinner,
} from './entryPhysicsBrief';
import type { TradeLevels } from './tradeLevels';

const downLevels: TradeLevels = {
  lane: 'down',
  entry: 0.44,
  takeProfit: 0.52,
  stopLoss: 0.38,
  takeProfitGain: 0.08,
  stopLossLoss: 0.06,
  rrRatio: 1.33,
  horizonSec: 300,
  summary: 'test',
  collapsed: false,
};

const base = {
  spot: 99_900,
  ptb: 100_000,
  bandUsd: 50,
  entryLane: 'down' as const,
  flowWinningLane: 'down' as const,
  lastProbUp: 0.42,
  lastProbDown: 0.58,
  wallHeadline: 'Down wall ask 44¢',
  upLabel: 'Up',
  downLabel: 'Down',
};

describe('spotGeometricWinner', () => {
  it('returns at when inside band', () => {
    expect(spotGeometricWinner(100_010, 100_000, 50)).toBe('at');
  });
  it('returns up when clearly above', () => {
    expect(spotGeometricWinner(100_200, 100_000, 50)).toBe('up');
  });
});

describe('buildEntryPhysicsBrief', () => {
  it('explains DOWN entry with spot below PTB', () => {
    const s = buildEntryPhysicsBrief(base);
    expect(s).toContain('Down');
    expect(s).toContain('below PTB');
    expect(s).toMatch(/geometry favors Down/i);
  });

  it('flags spot vs book conflict', () => {
    const s = buildEntryPhysicsBrief({
      ...base,
      spot: 100_200,
      entryLane: 'down',
      flowWinningLane: 'down',
      lastProbUp: 0.55,
      lastProbDown: 0.45,
      wallHeadline: null,
    });
    expect(s).toMatch(/risky entry|wrong side|does not match|size down|wait/i);
  });

  it('includes bell and bracket when provided', () => {
    const blocks = buildTradePhysicsBlocks({
      ...base,
      endsInMs: 45_000,
      crossProb: 0.2,
      levels: downLevels,
    });
    expect(blocks.some((b) => b.id === 'bell')).toBe(true);
    expect(blocks.some((b) => b.id === 'bracket')).toBe(true);
  });
});

describe('buildExitPhysicsBrief', () => {
  it('describes hold when spot matches held lane', () => {
    const s = buildExitPhysicsBrief({ ...base, heldLane: 'down' });
    expect(s).toContain('marked Down');
    expect(s).toMatch(/thesis intact|on your side/i);
  });
});

describe('buildTakeSignalPhysicsHint', () => {
  it('mentions limit buy and TP/SL', () => {
    const s = buildTakeSignalPhysicsHint({
      ...base,
      levels: downLevels,
    });
    expect(s).toMatch(/Limit buy Down/i);
    expect(s).toMatch(/TP.*SL/i);
  });
});
