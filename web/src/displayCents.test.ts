import { describe, expect, it } from 'vitest';
import { formatCentsFrom01, formatCentsLabelFrom01, price01ToWholeCents } from './displayCents';

describe('displayCents', () => {
  it('rounds to whole cents', () => {
    expect(price01ToWholeCents(0.845)).toBe(85);
    expect(formatCentsFrom01(0.545)).toBe('55');
    expect(formatCentsLabelFrom01(0.62)).toBe('62¢');
  });
});
