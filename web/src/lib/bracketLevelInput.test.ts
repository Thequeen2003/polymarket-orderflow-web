import { describe, expect, it } from 'vitest';
import {
  bracketAuxFromCents,
  bracketConversionFromInput,
  bracketRef01,
  centsStrFromTarget01,
  resolveBracketRef,
  target01FromBracketInput,
} from './bracketLevelInput';

describe('bracketLevelInput', () => {
  const ref = 0.5;

  it('prefers avg entry over buy price and mid for ref', () => {
    expect(bracketRef01(0.48, 0.52)).toBe(0.48);
    expect(bracketRef01(null, 0.52, 0.47)).toBe(0.47);
    expect(bracketRef01(null, 0.52)).toBe(0.52);
    expect(resolveBracketRef({ avgEntry01: 0.48, plannedEntry01: 0.47, mid01: 0.52 })).toEqual({
      ref01: 0.48,
      source: 'avg_entry',
    });
    expect(resolveBracketRef({ plannedEntry01: 0.47, mid01: 0.52 })).toEqual({
      ref01: 0.47,
      source: 'buy_price',
    });
  });

  it('converts SL pct and usd per share', () => {
    expect(target01FromBracketInput({ mode: 'pct', raw: '10', kind: 'sl', ref01: ref })).toBeCloseTo(0.45, 5);
    expect(target01FromBracketInput({ mode: 'usd', raw: '0.05', kind: 'sl', ref01: ref })).toBeCloseTo(0.45, 5);
  });

  it('converts TP pct and usd per share', () => {
    expect(target01FromBracketInput({ mode: 'pct', raw: '10', kind: 'tp', ref01: ref })).toBeCloseTo(0.55, 5);
    expect(target01FromBracketInput({ mode: 'usd', raw: '0.05', kind: 'tp', ref01: ref })).toBeCloseTo(0.55, 5);
  });

  it('converts total-$ TP/SL when shares are known ($1000 @ 50¢ → 2000 sh, $50 profit)', () => {
    const shares = 2000;
    expect(
      target01FromBracketInput({ mode: 'usd', raw: '50', kind: 'tp', ref01: ref, shares }),
    ).toBeCloseTo(0.525, 5);
    expect(
      target01FromBracketInput({ mode: 'usd', raw: '50', kind: 'sl', ref01: ref, shares }),
    ).toBeCloseTo(0.475, 5);
    expect(
      bracketAuxFromCents({ mode: 'usd', centsStr: '52.5', kind: 'tp', ref01: ref, shares }),
    ).toBe('50');
  });

  it('formats cents and round-trips aux display', () => {
    expect(centsStrFromTarget01(0.55)).toBe('55');
    expect(bracketAuxFromCents({ mode: 'pct', centsStr: '45', kind: 'sl', ref01: ref })).toBe('10');
    expect(bracketAuxFromCents({ mode: 'usd', centsStr: '55', kind: 'tp', ref01: ref })).toBe('0.05');
  });

  it('live conversion preview from any input mode', () => {
    expect(
      bracketConversionFromInput({ mode: 'pct', raw: '10', kind: 'tp', ref01: ref }),
    ).toMatchObject({ centsLabel: '55¢', pctLabel: '10%', usdLabel: '$0.05', usdUsesTotal: false });
    expect(
      bracketConversionFromInput({ mode: 'usd', raw: '0.05', kind: 'sl', ref01: ref }),
    ).toMatchObject({ centsLabel: '45¢', pctLabel: '10%', usdLabel: '$0.05' });
    expect(
      bracketConversionFromInput({ mode: 'cents', raw: '55', kind: 'tp', ref01: ref }),
    ).toMatchObject({ centsLabel: '55¢', pctLabel: '10%', usdLabel: '$0.05' });
    const buyRef = 0.48;
    expect(
      bracketConversionFromInput({ mode: 'cents', raw: '55', kind: 'tp', ref01: buyRef }),
    ).toMatchObject({ centsLabel: '55¢', usdLabel: '$0.07' });
    expect(
      bracketConversionFromInput({ mode: 'usd', raw: '50', kind: 'tp', ref01: ref, shares: 2000 }),
    ).toMatchObject({
      centsLabel: '52.5¢',
      usdLabel: '$50',
      usdUsesTotal: true,
      usdDetail: '≈ $0.025/sh · 2,000 sh',
    });
  });

  it('buy-bundle: total $ uses est order shares, not held shares', () => {
    const buyLimit = 0.5;
    const estShares = 2000;
    const heldShares = 120;
    // Wrong: held shares → $50 profit would imply tiny per-share move
    expect(
      bracketConversionFromInput({ mode: 'cents', raw: '52.5', kind: 'tp', ref01: buyLimit, shares: heldShares }),
    ).toMatchObject({ usdLabel: '$3', usdUsesTotal: true });
    // Correct: full buy size
    expect(
      bracketConversionFromInput({ mode: 'cents', raw: '52.5', kind: 'tp', ref01: buyLimit, shares: estShares }),
    ).toMatchObject({ usdLabel: '$50', usdUsesTotal: true });
    expect(
      bracketConversionFromInput({ mode: 'usd', raw: '50', kind: 'tp', ref01: buyLimit, shares: estShares }),
    ).toMatchObject({ centsLabel: '52.5¢', usdLabel: '$50' });
  });
});
