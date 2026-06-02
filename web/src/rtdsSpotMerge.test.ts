import { describe, expect, it } from 'vitest';
import { acceptChainlinkUsdSpot, mergeSpotHistory } from './rtdsSpotMerge';

describe('acceptChainlinkUsdSpot', () => {
  it('rejects binance-labeled ticks on slash-USD', () => {
    expect(acceptChainlinkUsdSpot(73_955.93, 'binance')).toBe(false);
    expect(acceptChainlinkUsdSpot(73_848.22, 'chainlink')).toBe(true);
  });
});

describe('mergeSpotHistory', () => {
  it('drops binance contamination from btc/usd series', () => {
    const prev = [{ t: 100, v: 73_955.93 }];
    const next = mergeSpotHistory(
      prev,
      {
        value: 73_848.223265,
        ts: 101,
        source: 'chainlink',
        history: [{ t: 101, v: 73_848.223265, src: 'chainlink' }],
      },
      'btc/usd',
    );
    expect(next.every((p) => acceptChainlinkUsdSpot(p.v, 'chainlink'))).toBe(true);
    expect(next[next.length - 1]!.v).toBeCloseTo(73_848.223265, 4);
  });
});
