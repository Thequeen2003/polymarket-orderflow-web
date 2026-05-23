import { describe, expect, it } from 'vitest';

import { computeDualOutcomeWallFlow, formatWallBidWarnings } from './dualOutcomeWalls';

describe('computeDualOutcomeWallFlow', () => {
  it('favors DOWN on wall ask; wall bid is warning only', () => {
    const flow = computeDualOutcomeWallFlow({
      upBook: {
        bids: [
          { price: 0.55, size: 45 },
          { price: 0.54, size: 20 },
          { price: 0.53, size: 18 },
        ],
        asks: [
          { price: 0.56, size: 520 },
          { price: 0.57, size: 22 },
          { price: 0.58, size: 19 },
        ],
      },
      downBook: {
        bids: [
          { price: 0.44, size: 510 },
          { price: 0.43, size: 21 },
          { price: 0.42, size: 17 },
        ],
        asks: [
          { price: 0.45, size: 38 },
          { price: 0.46, size: 20 },
          { price: 0.47, size: 16 },
        ],
      },
      upLabel: 'Up',
      downLabel: 'Down',
      entryLane: 'down',
    });
    expect(flow?.flowLane).toBe('down');
    expect(flow?.up?.askWall).toBe(true);
    expect(flow?.down?.bidWall).toBe(true);
    expect(flow?.headline).toMatch(/wall ask/i);
    expect(flow?.bidWarnings.length).toBeGreaterThan(0);
    expect(flow?.bidWarnings.some((w) => w.lane === 'down')).toBe(true);
    const warn = formatWallBidWarnings(flow!.bidWarnings, 'down');
    expect(warn).toMatch(/wall bid/i);
    expect(warn).toMatch(/don't chase/i);
  });

  it('favors UP when UP bid wall and DOWN ask wall', () => {
    const flow = computeDualOutcomeWallFlow({
      upBook: {
        bids: [
          { price: 0.6, size: 420 },
          { price: 0.59, size: 24 },
          { price: 0.58, size: 19 },
        ],
        asks: [
          { price: 0.61, size: 32 },
          { price: 0.62, size: 21 },
          { price: 0.63, size: 18 },
        ],
      },
      downBook: {
        bids: [
          { price: 0.39, size: 28 },
          { price: 0.38, size: 20 },
          { price: 0.37, size: 17 },
        ],
        asks: [
          { price: 0.4, size: 380 },
          { price: 0.41, size: 22 },
          { price: 0.42, size: 16 },
        ],
      },
    });
    expect(flow?.flowLane).toBe('up');
    expect(flow?.up?.bidWall).toBe(true);
    expect(flow?.down?.askWall).toBe(true);
    expect(flow?.bidWarnings.some((w) => w.lane === 'up')).toBe(true);
  });
});
