import { describe, expect, it } from 'vitest';
import { shouldAutoRollUpdownMarket } from './updownAutoRoll';

describe('updownAutoRoll', () => {
  it('rolls when the window ended or Gamma closed the market', () => {
    expect(shouldAutoRollUpdownMarket({ endsInMs: -1_000, marketClosed: false })).toBe(true);
    expect(shouldAutoRollUpdownMarket({ endsInMs: 1_500, marketClosed: false })).toBe(true);
    expect(shouldAutoRollUpdownMarket({ endsInMs: null, marketClosed: true })).toBe(true);
    expect(shouldAutoRollUpdownMarket({ endsInMs: 60_000, marketClosed: false })).toBe(false);
  });
});
