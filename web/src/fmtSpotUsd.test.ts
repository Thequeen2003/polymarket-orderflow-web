import { describe, expect, it } from 'vitest';
import { fmtSpotUsd, fmtSpotUsdAxis, fmtSpotUsdSigned } from './fmtSpotUsd';

describe('fmtSpotUsd', () => {
  it('always shows two decimal places', () => {
    expect(fmtSpotUsd(64417)).toBe('$64,417.00');
    expect(fmtSpotUsd(64417.229)).toBe('$64,417.23');
  });

  it('matches axis and signed variants', () => {
    expect(fmtSpotUsdAxis(64417.5)).toBe('$64,417.50');
    expect(fmtSpotUsdSigned(-12.3)).toBe('-$12.30');
  });
});
