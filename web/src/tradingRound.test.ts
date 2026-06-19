import { describe, expect, it } from 'vitest';
import { floorSharesWhole, floorUsdWhole } from './tradingRound';

describe('floorSharesWhole', () => {
  it('floors fractional shares to whole numbers', () => {
    expect(floorSharesWhole(12.9999)).toBe(12);
    expect(floorSharesWhole(0.5)).toBe(0);
    expect(floorSharesWhole(7)).toBe(7);
  });
});

describe('floorUsdWhole', () => {
  it('floors fractional dollars to whole numbers', () => {
    expect(floorUsdWhole(99.99)).toBe(99);
    expect(floorUsdWhole(0.01)).toBe(0);
    expect(floorUsdWhole(250)).toBe(250);
  });
});
