import { describe, expect, it } from 'vitest';

import { formatCountdownSec, formatHorizonTimeFrame } from './pricePredictionSignal';

describe('PredictionHorizonTimer helpers', () => {
  it('formats time frames for each horizon', () => {
    expect(formatHorizonTimeFrame(0)).toBe('Live · now');
    expect(formatHorizonTimeFrame(30)).toBe('30s horizon');
    expect(formatHorizonTimeFrame(60)).toBe('1m horizon');
    expect(formatHorizonTimeFrame(300)).toBe('5m horizon');
  });

  it('formats ticking countdown display', () => {
    expect(formatCountdownSec(30)).toBe('0:30');
    expect(formatCountdownSec(59)).toBe('0:59');
    expect(formatCountdownSec(60)).toBe('1:00');
    expect(formatCountdownSec(300)).toBe('5:00');
  });
});
