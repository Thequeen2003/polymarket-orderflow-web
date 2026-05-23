import { describe, expect, it } from 'vitest';
import {
  fillMatchesSignalEntry,
  formatBracketCentsFrom01,
  resolveArmRiskCentsAfterBuy,
  resolveArmRiskCentsForEntry,
  spreadBracketFromFillPrice01,
  tradeLevelsToRiskCents,
} from './armRiskFromSignal';
import { suggestTradeLevels } from './tradeLevels';

describe('fillMatchesSignalEntry', () => {
  it('matches within default 4¢ band', () => {
    expect(fillMatchesSignalEntry(0.62, 0.618)).toBe(true);
    expect(fillMatchesSignalEntry(0.62, 0.665)).toBe(false);
  });
});

describe('formatBracketCentsFrom01', () => {
  it('matches desk take-signal cent strings', () => {
    expect(formatBracketCentsFrom01(0.46)).toBe('46');
    expect(formatBracketCentsFrom01(0.545)).toBe('55');
  });
});

describe('tradeLevelsToRiskCents', () => {
  it('maps card levels to cent strings', () => {
    const lv = suggestTradeLevels({ lane: 'up', entry: 0.5, edgeUsd: 0.03 });
    expect(lv).not.toBeNull();
    const c = tradeLevelsToRiskCents(lv!);
    expect(c!.tpCents).toBe('54');
    expect(c!.stopCents).toBe('46');
  });
});

describe('resolveArmRiskCentsForEntry', () => {
  it('uses signal TP/SL when lane matches without fill proximity check', () => {
    const r = resolveArmRiskCentsForEntry({
      entry01: 0.58,
      lane: 'up',
      bookTouch: { bestBid: 0.57, bestAsk: 0.59 },
      useSignalLevels: true,
      signal: {
        slug: 'x',
        lane: 'up',
        entry01: 0.5,
        takeProfit01: 0.54,
        stopLoss01: 0.46,
        updatedAtMs: Date.now(),
      },
    });
    expect(r.source).toBe('signal');
    expect(r.tpCents).toBe('54');
  });
});

describe('resolveArmRiskCentsAfterBuy', () => {
  const touch = { bestBid: 0.59, bestAsk: 0.61 };

  it('uses signal TP/SL when fill is near signal entry on the same lane', () => {
    const r = resolveArmRiskCentsAfterBuy({
      fillPrice01: 0.502,
      lane: 'up',
      bookTouch: touch,
      useSignalLevels: true,
      signal: {
        slug: 'btc-up',
        lane: 'up',
        entry01: 0.5,
        takeProfit01: 0.54,
        stopLoss01: 0.46,
        updatedAtMs: Date.now(),
      },
    });
    expect(r.source).toBe('signal');
    expect(r.tpCents).toBe('54');
    expect(r.stopCents).toBe('46');
  });

  it('uses signal TP/SL even when fill slipped from card entry (desk take)', () => {
    const r = resolveArmRiskCentsAfterBuy({
      fillPrice01: 0.58,
      lane: 'up',
      bookTouch: touch,
      useSignalLevels: true,
      signal: {
        slug: 'btc-up',
        lane: 'up',
        entry01: 0.5,
        takeProfit01: 0.54,
        stopLoss01: 0.46,
        updatedAtMs: Date.now(),
      },
    });
    expect(r.source).toBe('signal');
    expect(r.tpCents).toBe('54');
  });

  it('falls back to spread when legacy fill proximity is required', () => {
    const signal = {
      slug: 'btc-up',
      lane: 'up' as const,
      entry01: 0.5,
      takeProfit01: 0.54,
      stopLoss01: 0.46,
      updatedAtMs: Date.now(),
    };
    const spread = spreadBracketFromFillPrice01(0.58, touch);
    const r = resolveArmRiskCentsAfterBuy({
      fillPrice01: 0.58,
      lane: 'up',
      bookTouch: touch,
      useSignalLevels: true,
      trustSignalCardRegardlessOfFill: false,
      signal,
    });
    expect(r.source).toBe('spread');
    expect(r.tpCents).toBe(spread.tpCents);
    expect(r.stopCents).toBe(spread.stopCents);
  });

  it('falls back when lane mismatches', () => {
    const r = resolveArmRiskCentsAfterBuy({
      fillPrice01: 0.5,
      lane: 'down',
      bookTouch: touch,
      useSignalLevels: true,
      signal: {
        slug: 'x',
        lane: 'up',
        entry01: 0.5,
        takeProfit01: 0.54,
        stopLoss01: 0.46,
        updatedAtMs: Date.now(),
      },
    });
    expect(r.source).toBe('spread');
  });
});
