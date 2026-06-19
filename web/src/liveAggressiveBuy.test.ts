import { describe, expect, it } from 'vitest';
import { aggressiveBuyPrice01, marketBuyUsdFromIntent, safeMarketBuyUsd } from './liveAggressiveBuy';

describe('liveAggressiveBuy', () => {
  it('slips above best ask for fill room', () => {
    expect(aggressiveBuyPrice01(0.96)).toBeGreaterThan(0.96);
    expect(aggressiveBuyPrice01(0.96)).toBeLessThanOrEqual(0.99);
  });

  it('trims USD notional for balance headroom', () => {
    expect(safeMarketBuyUsd(56.79)).toBeLessThan(56.79);
    expect(safeMarketBuyUsd(56.79)).toBeGreaterThan(56);
  });

  it('builds market USD from share intent', () => {
    const usd = marketBuyUsdFromIntent({
      unit: 'shares',
      dollars: 0,
      shares: 7,
      refAsk01: 0.96,
    });
    expect(usd).toBeGreaterThan(6.5);
    expect(usd).toBeLessThan(7.5);
  });
});
