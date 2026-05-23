import { describe, expect, it } from 'vitest';
import { formatBullpenPriceArg, roundPriceToTick } from './priceTick.js';

describe('priceTick', () => {
  it('rounds 0.545 to 2dp tick', () => {
    expect(roundPriceToTick(0.545)).toBe(0.55);
    expect(formatBullpenPriceArg(0.545)).toBe('0.55');
  });

  it('keeps exact cent prices', () => {
    expect(roundPriceToTick(0.54)).toBe(0.54);
    expect(formatBullpenPriceArg(0.54)).toBe('0.54');
  });

  it('rounds float noise from book mids', () => {
    expect(formatBullpenPriceArg(0.539999999)).toBe('0.54');
  });
});
