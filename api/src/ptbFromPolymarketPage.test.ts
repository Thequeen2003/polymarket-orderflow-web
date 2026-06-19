import { describe, expect, it } from 'vitest';
import { tryPolymarketPagePtb } from './ptbFromPolymarketPage.js';

describe('tryPolymarketPagePtb', () => {
  it('parses priceToBeat from embedded event JSON', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () =>
      ({
        ok: true,
        text: async () => '<script>{"priceToBeat":61883.2293952956}</script>',
      }) as Response;
    try {
      const out = await tryPolymarketPagePtb('btc-updown-4h-1781121600', 'https://polymarket.com');
      expect(out?.value).toBeCloseTo(61883.2293952956, 4);
      expect(out?.source).toBe('polymarket_page_price_to_beat');
    } finally {
      globalThis.fetch = orig;
    }
  });
});
