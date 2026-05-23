import { describe, expect, it } from 'vitest';
import { resolveUpDownIndices } from './upDown.js';

describe('resolveUpDownIndices', () => {
  it('maps Yes/No to up/down on canonical updown slugs without question hints', () => {
    const idx = resolveUpDownIndices(['Yes', 'No'], { slug: 'btc-updown-5m-1778978100' });
    expect(idx).toEqual({ up: 0, down: 1 });
  });

  it('finds Up/Down when labels are reversed in the array', () => {
    const idx = resolveUpDownIndices(['Down', 'Up'], { slug: 'btc-updown-5m-100' });
    expect(idx).toEqual({ up: 1, down: 0 });
  });
});
