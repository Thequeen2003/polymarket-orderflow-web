import { describe, expect, it } from 'vitest';

import { shouldAutoOpenCrossCheck } from './SignalsPtbOnly';

describe('shouldAutoOpenCrossCheck', () => {
  it('opens when the strip first enters a warning state', () => {
    expect(shouldAutoOpenCrossCheck('AGREE', 'CONFLICT')).toBe(true);
    expect(shouldAutoOpenCrossCheck('STRONG', 'INCOMPLETE')).toBe(true);
  });

  it('does not reopen on warning-to-warning churn', () => {
    expect(shouldAutoOpenCrossCheck('CONFLICT', 'INCOMPLETE')).toBe(false);
    expect(shouldAutoOpenCrossCheck('INCOMPLETE', 'CONFLICT')).toBe(false);
  });

  it('stays closed for non-warning states', () => {
    expect(shouldAutoOpenCrossCheck('AGREE', 'STRONG')).toBe(false);
    expect(shouldAutoOpenCrossCheck('INCOMPLETE', 'AGREE')).toBe(false);
  });
});
