import { describe, expect, it } from 'vitest';
import {
  bracketCentsStrTo01,
  effectiveBracketCents01,
  effectiveBracketCentsStr,
  formatBracketCentsFromRaw,
  sanitizeBracketCentsDraft,
  shouldCommitBracketCentsOnBlur,
} from './bracketCentsInput';

describe('bracketCentsInput', () => {
  it('sanitizes draft input to whole cents only', () => {
    expect(sanitizeBracketCentsDraft('55.2x')).toBe('55');
    expect(sanitizeBracketCentsDraft('12.34')).toBe('12');
  });

  it('rejects single-digit blur when committed was a full price', () => {
    expect(
      shouldCommitBracketCentsOnBlur({ draftRaw: '5', committedRaw: '55', pressedEnter: false }),
    ).toBe(false);
    expect(
      shouldCommitBracketCentsOnBlur({ draftRaw: '5', committedRaw: '55', pressedEnter: true }),
    ).toBe(true);
  });

  it('allows small edits on blur', () => {
    expect(
      shouldCommitBracketCentsOnBlur({ draftRaw: '58', committedRaw: '55', pressedEnter: false }),
    ).toBe(true);
  });

  it('rejects blur after a partial auto-commit while typing a multi-digit price', () => {
    expect(
      shouldCommitBracketCentsOnBlur({ draftRaw: '58', committedRaw: '5', pressedEnter: false }),
    ).toBe(false);
    expect(
      shouldCommitBracketCentsOnBlur({ draftRaw: '58', committedRaw: '5', pressedEnter: true }),
    ).toBe(true);
  });

  it('formats commit strings', () => {
    expect(formatBracketCentsFromRaw('58')).toBe('58');
    expect(formatBracketCentsFromRaw('58.0')).toBe('58');
  });

  it('bracketCentsStrTo01 supports decimal trigger cents for automation', () => {
    expect(bracketCentsStrTo01('52.5')).toBeCloseTo(0.53, 6);
    expect(bracketCentsStrTo01('58')).toBeCloseTo(0.58, 6);
  });

  it('effectiveBracketCents prefers pending draft while editing', () => {
    expect(effectiveBracketCentsStr('55', '58')).toBe('58');
    expect(effectiveBracketCents01('55', '58')).toBeCloseTo(0.58, 6);
    expect(effectiveBracketCents01('55', null)).toBeCloseTo(0.55, 6);
  });
});
