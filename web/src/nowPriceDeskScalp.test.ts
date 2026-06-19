import { describe, expect, it } from 'vitest';
import {
  buildNowPriceDeskScalpPlan,
  deskTpBelowEntry,
  globalStopCentsFromEntry,
  liveDeskTp01FromBook,
  parseGlobalStopOffsetCents,
  resolveGlobalStopForEntry,
  shouldSubmitDeskScalpBuy,
} from './nowPriceDeskScalp';
import type { BuySideAdvisory } from './shouldBuyWhichSide';

const buyUpAdvisory: BuySideAdvisory = {
  verdict: 'BUY_UP',
  confidence: 'HIGH',
  recommendation: 'Buy UP — tape favors upside.',
  reasons: ['flow'],
  risks: ['bell'],
  suggestedSize: 0.5,
  edgePerShareUsd: 0.02,
  winProb: 0.62,
  mid: 0.55,
  scores: { up: 3, down: 1 },
  cautionFresh: false,
};

describe('globalStopCentsFromEntry', () => {
  it('places stop offset below fill', () => {
    expect(globalStopCentsFromEntry(0.62, '8')).toBe('54');
  });

  it('rejects invalid offset', () => {
    expect(parseGlobalStopOffsetCents('')).toBeNull();
    expect(globalStopCentsFromEntry(0.62, '')).toBeNull();
  });
});

describe('resolveGlobalStopForEntry', () => {
  it('returns stop when enabled', () => {
    const sl = resolveGlobalStopForEntry(0.5, {
      globalStopLossCents: '10',
      useGlobalStopOnEveryBuy: true,
      trailingProfit: false,
      takeLossWhenDeskTpBelowEntry: false,
      autoDeskScalp: false,
      submitBuyOnTake: false,
    });
    expect(sl).toBe('40');
  });

  it('skips when disabled', () => {
    expect(
      resolveGlobalStopForEntry(0.5, {
        globalStopLossCents: '10',
        useGlobalStopOnEveryBuy: false,
        trailingProfit: false,
        autoDeskScalp: false,
        takeLossWhenDeskTpBelowEntry: false,
        submitBuyOnTake: false,
      }),
    ).toBeNull();
  });
});

describe('deskTpBelowEntry', () => {
  it('detects when live desk TP is under fill', () => {
    expect(deskTpBelowEntry(0.55, 0.52)).toBe(true);
    expect(deskTpBelowEntry(0.55, 0.58)).toBe(false);
  });

  it('reads desk TP from book', () => {
    const tp01 = liveDeskTp01FromBook({ bestAsk: 0.55, bestBid: 0.54 });
    expect(tp01).not.toBeNull();
    expect(tp01!).toBeGreaterThan(0.54);
  });
});

describe('shouldSubmitDeskScalpBuy', () => {
  it('requires submitBuyOnTake and valid shares', () => {
    expect(shouldSubmitDeskScalpBuy({ submitBuyOnTake: false }, 10)).toBe(false);
    expect(shouldSubmitDeskScalpBuy({ submitBuyOnTake: true }, null)).toBe(false);
  });
});

describe('buildNowPriceDeskScalpPlan', () => {
  it('builds plan for BUY_UP with global SL', () => {
    const plan = buildNowPriceDeskScalpPlan({
      advisory: buyUpAdvisory,
      bookTouchUp: { bestAsk: 0.55, bestBid: 0.54 },
      bookTouchDown: { bestAsk: 0.46, bestBid: 0.45 },
      midUp01: 0.545,
      midDown01: 0.455,
      scalpPrefs: {
        globalStopLossCents: '8',
        useGlobalStopOnEveryBuy: true,
        trailingProfit: false,
        autoDeskScalp: false,
        submitBuyOnTake: false,
      },
    });
    expect(plan.canTake).toBe(true);
    expect(plan.lane).toBe('up');
    expect(plan.entry01).toBe(0.55);
    expect(plan.stopCentsStr).toBe('47');
    expect(plan.takeProfit01).not.toBeNull();
  });

  it('blocks when no desk pick', () => {
    const plan = buildNowPriceDeskScalpPlan({
      advisory: { ...buyUpAdvisory, verdict: 'NEITHER' },
      bookTouchUp: null,
      bookTouchDown: null,
      midUp01: 0.5,
      midDown01: 0.5,
    });
    expect(plan.canTake).toBe(false);
  });
});
