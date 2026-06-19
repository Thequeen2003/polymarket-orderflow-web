import { describe, expect, it, vi } from 'vitest';

vi.mock('./updownCanonicalProbe.js', () => ({
  resolveCanonicalUpdownSlug: vi.fn(async () => ({
    slug: 'btc-updown-5m-1700000000',
    ts: 1700000000,
    market: { slug: 'btc-updown-5m-1700000000' },
  })),
}));

vi.mock('./polymarket/index.js', () => ({
  clobBookHttp: vi.fn(async () => ({ bids: [[0.48, 100]], asks: [[0.52, 100]] })),
  clobLastTradePrice: vi.fn(async () => ({ price: '0.5', side: 'BUY' })),
  dataApiRecentTrades: vi.fn(async () => []),
  parseClobTokenIds: (raw: unknown) => {
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as string[];
      } catch {
        return [];
      }
    }
    return Array.isArray(raw) ? raw.map(String) : [];
  },
}));

import { buildAgentSnapshot } from './agentSnapshot.js';

describe('buildAgentSnapshot', () => {
  it('assembles outcomes from mocked deps', async () => {
    const snap = await buildAgentSnapshot(
      { asset: 'btc', interval: '5m', spotHistoryLimit: 30, tapeLimit: 5, bookDepth: 3 },
      {
        resolveMarketBySlug: async () => ({
          slug: 'btc-updown-5m-1700000000',
          question: 'Bitcoin Up or Down',
          conditionId: '0x' + 'a'.repeat(64),
          active: true,
          closed: false,
          outcomes: '["Up","Down"]',
          clobTokenIds: '["111","222"]',
        }),
        tryPriceToBeat: async () => null,
        tryRtdsBucketPtb: async () => ({ value: 95000.5, source: 'rtds_chainlink_window_open' }),
        tryPolymarketPagePtb: async () => null,
        parseUpdownBucketFromSlug: () => ({ symbol: 'btc/usd', bucketStartMs: 1700000000 * 1000 }),
        inferBucketFromTitledUpdownSlug: async () => null,
        ensureRtdsWs: async () => {},
        waitForRtdsPrice: async () => null,
        rtdsHistoryForSymbol: () => [{ t: Date.now(), v: 95100, src: 'chainlink' }],
        latestChainlinkUsdPrice: () => ({
          symbol: 'btc/usd',
          value: 95100,
          ts: Date.now(),
          receivedAt: Date.now(),
          source: 'chainlink',
        }),
      },
    );
    expect(snap.schema).toBe('polymarket-orderflow-agent-snapshot/v1');
    expect(snap.query).toEqual({ asset: 'btc', interval: '5m' });
    expect(snap.underlying.priceToBeat?.priceToBeatUsd).toBe(95000.5);
    expect(snap.market.clobTokenIds).toEqual(['111', '222']);
  });
});
