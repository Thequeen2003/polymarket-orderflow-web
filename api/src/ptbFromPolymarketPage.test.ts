import { describe, expect, it } from 'vitest';
import { parsePolymarketPagePtbFromHtml, tryPolymarketPagePtb } from './ptbFromPolymarketPage.js';

describe('parsePolymarketPagePtbFromHtml', () => {
  it('parses locked priceToBeat from embedded event JSON', () => {
    const out = parsePolymarketPagePtbFromHtml('<script>{"priceToBeat":61883.2293952956}</script>');
    expect(out?.value).toBeCloseTo(61883.2293952956, 4);
    expect(out?.source).toBe('polymarket_page_price_to_beat');
  });

  it('parses active-window openPrice when closePrice is still null', () => {
    const out = parsePolymarketPagePtbFromHtml(
      '{"state":{"data":{"openPrice":63520.44797620156,"closePrice":null}}}',
    );
    expect(out?.value).toBeCloseTo(63520.44797620156, 4);
    expect(out?.source).toBe('polymarket_page_open_price');
  });

  it('prefers priceToBeat over openPrice when both are present', () => {
    const out = parsePolymarketPagePtbFromHtml(
      '{"priceToBeat":76611.31,"openPrice":63520.44,"closePrice":null}',
    );
    expect(out?.value).toBeCloseTo(76611.31, 2);
    expect(out?.source).toBe('polymarket_page_price_to_beat');
  });
});

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
