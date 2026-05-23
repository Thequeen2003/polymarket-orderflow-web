import { describe, expect, it } from 'vitest';
import { parseRestingOrderSnapshot } from './orderStatusParse';

describe('parseRestingOrderSnapshot', () => {
  it('does not treat UNFILLED as terminal filled', () => {
    const p = parseRestingOrderSnapshot({
      status: 'UNFILLED',
      size: 10,
      size_matched: 0,
      price: 0.55,
    });
    expect(p.isTerminal).toBe(false);
    expect(p.isCancelled).toBe(false);
  });

  it('treats FILLED with full match as terminal', () => {
    const p = parseRestingOrderSnapshot({
      status: 'FILLED',
      original_size: 10,
      size_matched: 10,
      price: 0.55,
    });
    expect(p.isTerminal).toBe(true);
    expect(p.isCancelled).toBe(false);
  });

  it('treats CANCELLED as terminal cancelled', () => {
    const p = parseRestingOrderSnapshot({ status: 'CANCELLED', size_matched: 0 });
    expect(p.isTerminal).toBe(true);
    expect(p.isCancelled).toBe(true);
  });

  it('does not treat limit price as fill average', () => {
    const p = parseRestingOrderSnapshot({
      status: 'MATCHED',
      price: 0.8,
      size_matched: 5,
      original_size: 5,
    });
    expect(p.limitPrice01).toBeCloseTo(0.8, 6);
    expect(p.avgPrice01).toBeNull();
  });
});
