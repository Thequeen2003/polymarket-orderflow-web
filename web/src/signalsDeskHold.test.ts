import { describe, expect, it } from 'vitest';
import { isOutcomePositionFlat } from './signalsDeskHold';

describe('isOutcomePositionFlat', () => {
  it('treats zero and dust as flat', () => {
    expect(isOutcomePositionFlat(0)).toBe(true);
    expect(isOutcomePositionFlat(1e-5)).toBe(true);
  });

  it('keeps meaningful size as not flat', () => {
    expect(isOutcomePositionFlat(0.01)).toBe(false);
    expect(isOutcomePositionFlat(null)).toBe(false);
    expect(isOutcomePositionFlat(undefined)).toBe(false);
  });
});
