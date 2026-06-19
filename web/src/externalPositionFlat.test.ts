import { describe, expect, it } from 'vitest';
import { isExternallyFlatPosition } from './externalPositionFlat';

describe('isExternallyFlatPosition', () => {
  it('flat when CLOB and sell sizing are zero', () => {
    expect(isExternallyFlatPosition({ clobBal: 0, sellShares: 0 })).toBe(true);
    expect(isExternallyFlatPosition({ clobBal: 0.00005, sellShares: 0 })).toBe(true);
  });

  it('not flat when CLOB still has shares', () => {
    expect(isExternallyFlatPosition({ clobBal: 4.5, sellShares: 4.5 })).toBe(false);
  });

  it('not flat when CLOB is unknown', () => {
    expect(isExternallyFlatPosition({ clobBal: null, sellShares: 0 })).toBe(false);
  });

  it('not flat when sell sizing still shows size', () => {
    expect(isExternallyFlatPosition({ clobBal: 0, sellShares: 2 })).toBe(false);
  });
});
