import { describe, expect, it } from 'vitest';
import { didCrossStop } from './stopLoss';

describe('didCrossStop', () => {
  it('detects down-cross through stop', () => {
    expect(didCrossStop({ prev: 0.61, curr: 0.6, stop: 0.6, dir: 'down' })).toBe(true);
    expect(didCrossStop({ prev: 0.6001, curr: 0.6, stop: 0.6, dir: 'down' })).toBe(true);
    expect(didCrossStop({ prev: 0.59, curr: 0.58, stop: 0.6, dir: 'down' })).toBe(false);
    expect(didCrossStop({ prev: 0.6, curr: 0.6, stop: 0.6, dir: 'down' })).toBe(false);
  });

  it('detects up-cross through stop', () => {
    expect(didCrossStop({ prev: 0.39, curr: 0.4, stop: 0.4, dir: 'up' })).toBe(true);
    expect(didCrossStop({ prev: 0.3999, curr: 0.4, stop: 0.4, dir: 'up' })).toBe(true);
    expect(didCrossStop({ prev: 0.41, curr: 0.42, stop: 0.4, dir: 'up' })).toBe(false);
    expect(didCrossStop({ prev: 0.4, curr: 0.4, stop: 0.4, dir: 'up' })).toBe(false);
  });
});

