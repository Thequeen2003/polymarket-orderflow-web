import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAPER_CONFIG,
  aggregateTapeNet,
  rollingRefHigh,
  stepPaperMarket,
  tapeLean,
} from './smartMoneyPaperEngine';
import type { DataTradeRow } from './lib/api';
import { pickBookLevels } from './bookLevels';

function makeRows(asset: string, side: 'BUY' | 'SELL', n: number, px: number, sz: number): DataTradeRow[] {
  return Array.from({ length: n }, () => ({
    timestamp: 1,
    side,
    price: px,
    size: sz,
    outcome: null,
    asset,
    transactionHash: null,
    pseudonym: null,
  }));
}

describe('smartMoneyPaperEngine', () => {
  it('aggregates tape notionals', () => {
    const rows = makeRows('tok', 'BUY', 2, 0.5, 10);
    const a = aggregateTapeNet(rows);
    expect(a.buyN).toBeCloseTo(10, 5);
    expect(a.sellN).toBe(0);
    expect(a.net).toBeCloseTo(10, 5);
  });

  it('detects lean from up vs down tape', () => {
    const up = makeRows('u', 'BUY', 3, 0.4, 5);
    const down = makeRows('d', 'BUY', 1, 0.4, 1);
    const t = tapeLean(up, down, 1);
    expect(t.lean).toBe('up');
  });

  it('rollingRefHigh', () => {
    expect(rollingRefHigh([0.1, 0.2, null, 0.15], 12)).toBe(0.2);
  });

  it('opens when tape skews, buy-below ref, and net4c gate is off', () => {
    const cfg = { ...DEFAULT_PAPER_CONFIG, requireNet4c: false, minTapeSkew: 0.1 };
    const upRows = makeRows('upTok', 'BUY', 5, 0.5, 20);
    const downRows = makeRows('dnTok', 'SELL', 2, 0.5, 2);
    // Deep enough book: synthetic flat book
    const bidAsk = { bids: [{ price: 0.5, size: 500 }], asks: [{ price: 0.51, size: 500 }] };
    const upBook = pickBookLevels(bidAsk);
    const downBook = pickBookLevels(bidAsk);
    // Use raw book shape CLOB style
    const upRaw = { bids: upBook.bids, asks: upBook.asks };
    const downRaw = { bids: downBook.bids, asks: downBook.asks };

    const res = stepPaperMarket({
      now: 1_000_000,
      key: 'btc-5m',
      slug: 'btc-updown-5m-100',
      lastSlug: 'btc-updown-5m-100',
      upBook: upRaw,
      downBook: downRaw,
      upTokenId: 'upTok',
      downTokenId: 'dnTok',
      upMid: 0.45,
      downMid: 0.55,
      upMidHistory: [0.55, 0.52, 0.5, 0.45],
      downMidHistory: [0.45, 0.46, 0.44],
      upRows,
      downRows,
      endsInMs: 120_000,
      pos: null,
      cfg,
    });
    expect(res.nextPos?.lane).toBe('up');
    expect(res.events.some((e) => e.kind === 'open')).toBe(true);
  });

  it('closes on take profit', () => {
    const cfg = DEFAULT_PAPER_CONFIG;
    const bidAsk = { bids: [{ price: 0.4, size: 500 }], asks: [{ price: 0.41, size: 500 }] };
    const res = stepPaperMarket({
      now: 2,
      key: 'btc-5m',
      slug: 's',
      lastSlug: 's',
      upBook: bidAsk,
      downBook: bidAsk,
      upTokenId: 'u',
      downTokenId: 'd',
      upMid: 0.5,
      downMid: 0.5,
      upMidHistory: [],
      downMidHistory: [],
      upRows: [],
      downRows: [],
      endsInMs: 120_000,
      pos: { lane: 'up', entryMid: 0.4, entryAtMs: 1, token: 'u', shares: cfg.refShares },
      cfg,
    });
    expect(res.nextPos).toBe(null);
    expect(res.events[0]?.kind).toBe('close');
  });
});
