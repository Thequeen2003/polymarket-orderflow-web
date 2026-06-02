import { describe, expect, it } from 'vitest';
import { mergeWsBestBidAsk, smoothBookLevels, smoothDepthMax, updateStableBookLadder } from './stableBookDisplay';

describe('mergeWsBestBidAsk', () => {
  it('does not clobber a deep book with BBA-only snapshot', () => {
    const existing = {
      bids: [
        { price: '0.48', size: '100' },
        { price: '0.47', size: '200' },
      ],
      asks: [
        { price: '0.52', size: '150' },
        { price: '0.53', size: '80' },
      ],
    };
    const out = mergeWsBestBidAsk(existing, { bestBid: '0.49', bestAsk: '0.51' });
    expect(out.bids.length).toBe(2);
    expect(out.asks.length).toBe(2);
  });

  it('seeds top of book when cache is empty', () => {
    const out = mergeWsBestBidAsk(undefined, { bestBid: '0.49', bestAsk: '0.51' });
    expect(out.bids[0]?.price).toBe('0.49');
    expect(out.asks[0]?.price).toBe('0.51');
  });
});

describe('smoothBookLevels', () => {
  it('eases size toward new value', () => {
    const first = smoothBookLevels(null, [{ price: 0.5, size: 100 }]);
    const second = smoothBookLevels(first.sizes, [{ price: 0.5, size: 200 }]);
    expect(second.levels[0]!.size).toBeGreaterThan(100);
    expect(second.levels[0]!.size).toBeLessThan(200);
  });
});

describe('updateStableBookLadder', () => {
  it('smooths max depth across updates', () => {
    const a = updateStableBookLadder(null, {
      bids: [{ price: 0.48, size: 1000 }],
      asks: [{ price: 0.52, size: 50 }],
    });
    const b = updateStableBookLadder(a, {
      bids: [{ price: 0.48, size: 100 }],
      asks: [{ price: 0.52, size: 50 }],
    });
    expect(b.maxBid).toBeGreaterThan(100);
    expect(b.maxBid).toBeLessThan(1000);
  });
});

describe('smoothDepthMax', () => {
  it('returns raw when prev invalid', () => {
    expect(smoothDepthMax(0, 500)).toBe(500);
  });
});
