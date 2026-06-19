import { describe, expect, it } from 'vitest';
import {
  bracketCentsEqual,
  buildQuoteAssistTargets,
  DEFAULT_EMERGENCY_STOP_BUNDLE_PREFS,
  flushPendingBracketCentsDraft,
  flushPendingBracketDraft,
  readStagedBuyBundleLevels,
  resolveAutoBundleChaseLevels,
  resolveStagedBuyBundleLevels,
  shouldChaseAutoBundleLevel,
  shouldPrefillBuyBundleTpOnClick,
} from './buyBundleStaging';

describe('buildQuoteAssistTargets', () => {
  it('matches spreadBracket whole-cent levels from executable quote', () => {
    const t = buildQuoteAssistTargets({
      quote01: 0.58,
      bestBid: 0.575,
      bestAsk: 0.58,
      sideLabel: 'TP (sell)',
    });
    expect(t).not.toBeNull();
    expect(t!.quoteCents).toBe('58');
    expect(t!.tpCents).toMatch(/^\d+$/);
    expect(t!.stopCents).toMatch(/^\d+$/);
    expect(Number(t!.tpCents)).toBeGreaterThan(Number(t!.quoteCents));
    expect(Number(t!.stopCents)).toBeLessThan(Number(t!.quoteCents));
  });
});

describe('bracketCentsEqual', () => {
  it('treats formatting variants as equal', () => {
    expect(bracketCentsEqual('43', '43.0')).toBe(true);
    expect(bracketCentsEqual('43.0', '43.5')).toBe(false);
  });
});

describe('resolveAutoBundleChaseLevels', () => {
  const quoteAssist = buildQuoteAssistTargets({
    quote01: 0.58,
    bestBid: 0.575,
    bestAsk: 0.58,
  });

  it('uses trade-card TP/SL when signal lane matches and useSignalLevels is on', () => {
    const r = resolveAutoBundleChaseLevels({
      lane: 'up',
      useSignalLevels: true,
      signal: {
        slug: 'btc-5m',
        lane: 'up',
        entry01: 0.58,
        takeProfit01: 0.72,
        stopLoss01: 0.52,
        updatedAtMs: Date.now(),
      },
      quoteAssist,
      entry01: 0.58,
      bookTouch: { bestBid: 0.575, bestAsk: 0.58 },
    });
    expect(r.source).toBe('signal');
    expect(r.tpCents).toBe('72');
    expect(r.slCents).toBe('52');
  });

  it('falls back to spread/quote when signal lane mismatches', () => {
    const r = resolveAutoBundleChaseLevels({
      lane: 'down',
      useSignalLevels: true,
      signal: {
        slug: 'btc-5m',
        lane: 'up',
        entry01: 0.58,
        takeProfit01: 0.72,
        stopLoss01: 0.52,
        updatedAtMs: Date.now(),
      },
      quoteAssist,
      entry01: 0.42,
      bookTouch: { bestBid: 0.415, bestAsk: 0.42 },
    });
    expect(r.source).toBe('quote');
    expect(r.tpCents).toBe(quoteAssist!.tpCents);
    expect(Number(r.tpCents)).toBeGreaterThan(42);
  });

  it('prefers live quote assist over static spread when signal is off', () => {
    const r = resolveAutoBundleChaseLevels({
      lane: 'up',
      useSignalLevels: false,
      signal: {
        slug: 'btc-5m',
        lane: 'up',
        entry01: 0.58,
        takeProfit01: 0.72,
        stopLoss01: 0.52,
        updatedAtMs: Date.now(),
      },
      quoteAssist,
      entry01: 0.58,
      bookTouch: { bestBid: 0.575, bestAsk: 0.58 },
    });
    expect(r.source).toBe('quote');
    expect(r.tpCents).toBe(quoteAssist!.tpCents);
    expect(r.tpCents).not.toBe('72');
  });

  it('updates signal TP when card levels change', () => {
    const base = {
      lane: 'up' as const,
      useSignalLevels: true,
      quoteAssist,
      entry01: 0.58,
      bookTouch: { bestBid: 0.575, bestAsk: 0.58 },
    };
    const first = resolveAutoBundleChaseLevels({
      ...base,
      signal: {
        slug: 'btc-5m',
        lane: 'up',
        entry01: 0.58,
        takeProfit01: 0.72,
        stopLoss01: 0.52,
        updatedAtMs: 1,
      },
    });
    const second = resolveAutoBundleChaseLevels({
      ...base,
      signal: {
        slug: 'btc-5m',
        lane: 'up',
        entry01: 0.58,
        takeProfit01: 0.75,
        stopLoss01: 0.51,
        updatedAtMs: 2,
      },
    });
    expect(first.tpCents).toBe('72');
    expect(second.tpCents).toBe('75');
    expect(second.slCents).toBe('51');
  });

  it('ignores signal when useSignalLevels is off', () => {
    const r = resolveAutoBundleChaseLevels({
      lane: 'up',
      useSignalLevels: false,
      signal: {
        slug: 'btc-5m',
        lane: 'up',
        entry01: 0.58,
        takeProfit01: 0.72,
        stopLoss01: 0.52,
        updatedAtMs: Date.now(),
      },
      quoteAssist: null,
      entry01: 0.58,
      bookTouch: { bestBid: 0.575, bestAsk: 0.58 },
    });
    expect(r.source).toBe('spread');
    expect(r.tpCents).not.toBe('72');
  });
});

describe('shouldChaseAutoBundleLevel', () => {
  it('chases empty or stale auto levels from quote assist', () => {
    expect(shouldChaseAutoBundleLevel({ manualLane: false, deskLocked: false, quoteCents: '43', curCents: '' })).toBe(
      true,
    );
    expect(shouldChaseAutoBundleLevel({ manualLane: false, deskLocked: false, quoteCents: '44', curCents: '43' })).toBe(
      true,
    );
    expect(shouldChaseAutoBundleLevel({ manualLane: false, deskLocked: false, quoteCents: '43', curCents: '43.0' })).toBe(
      false,
    );
  });

  it('stops on manual lane or desk lock', () => {
    expect(shouldChaseAutoBundleLevel({ manualLane: true, deskLocked: false, quoteCents: '44', curCents: '43' })).toBe(
      false,
    );
    expect(shouldChaseAutoBundleLevel({ manualLane: false, deskLocked: true, quoteCents: '44', curCents: '43' })).toBe(
      false,
    );
  });
});

describe('flushPendingBracketDraft', () => {
  it('commits typed cents draft that differs from staged value', () => {
    expect(
      flushPendingBracketDraft({
        draft: '81',
        mode: 'cents',
        committed: '91',
        kind: 'sl',
        ref01: 0.9,
      }),
    ).toBe('81');
  });

  it('returns null when cents draft matches committed', () => {
    expect(
      flushPendingBracketDraft({
        draft: '81',
        mode: 'cents',
        committed: '81',
        kind: 'sl',
        ref01: 0.9,
      }),
    ).toBeNull();
  });

  it('converts percent draft to trigger cents instead of treating digits as ¢', () => {
    expect(
      flushPendingBracketDraft({
        draft: '20',
        mode: 'pct',
        committed: '',
        kind: 'sl',
        ref01: 0.9375,
        shares: 100,
      }),
    ).toBe('75');
  });

  it('returns null when percent draft converts to already-committed cents', () => {
    expect(
      flushPendingBracketDraft({
        draft: '20',
        mode: 'pct',
        committed: '75',
        kind: 'sl',
        ref01: 0.9375,
        shares: 100,
      }),
    ).toBeNull();
  });
});

describe('flushPendingBracketCentsDraft', () => {
  it('commits typed draft that differs from staged value', () => {
    expect(flushPendingBracketCentsDraft({ draft: '81', committed: '91' })).toBe('81');
  });

  it('returns null when draft matches committed', () => {
    expect(flushPendingBracketCentsDraft({ draft: '81', committed: '81' })).toBeNull();
  });
});

describe('readStagedBuyBundleLevels', () => {
  it('reads only buy-tab bundle fields', () => {
    const levels = readStagedBuyBundleLevels('up', {
      up: { sl: '42', tp: '55' },
      down: { sl: '', tp: '' },
    });
    expect(levels).toEqual({ sl: '42', tp: '55' });
  });

  it('ignores sell-tab bracket drafts when buy bundle is empty', () => {
    const levels = readStagedBuyBundleLevels('down', {
      up: { sl: '', tp: '' },
      down: { sl: '', tp: '' },
    });
    expect(levels).toEqual({ sl: '', tp: '' });
  });

  it('reads TP from ref synchronously after Set TP on fill (no React re-render)', () => {
    const buyBundleByLane = { up: { sl: '', tp: '62.5' }, down: { sl: '', tp: '' } };
    expect(readStagedBuyBundleLevels('up', buyBundleByLane).tp).toBe('62.5');
  });
});

describe('resolveStagedBuyBundleLevels', () => {
  const empty = { up: { sl: '', tp: '' }, down: { sl: '', tp: '' } };

  it('does not auto-fill SL/TP until operator opts in', () => {
    const r = resolveStagedBuyBundleLevels('up', empty, {
      prefs: { autoFillSl: false, autoTpOnFill: false },
      suggestedSl: '38',
      suggestedTp: '52',
    });
    expect(r).toEqual({ sl: '', tp: '' });
  });

  it('auto-fills TP from quote assist when autoTpOnFill is on by default and field empty', () => {
    const r = resolveStagedBuyBundleLevels('up', empty, {
      prefs: DEFAULT_EMERGENCY_STOP_BUNDLE_PREFS,
      suggestedSl: '38',
      suggestedTp: '52',
    });
    expect(r).toEqual({ sl: '', tp: '52' });
  });

  it('auto-fills SL from suggested when autoFillSl is on and field empty', () => {
    const r = resolveStagedBuyBundleLevels('up', empty, {
      prefs: { autoFillSl: true, autoTpOnFill: false },
      suggestedSl: '38',
      suggestedTp: '52',
    });
    expect(r).toEqual({ sl: '38', tp: '' });
  });

  it('prefers global SL over auto-fill suggested SL', () => {
    const r = resolveStagedBuyBundleLevels('up', empty, {
      prefs: { autoFillSl: true, autoTpOnFill: false },
      suggestedSl: '38',
      suggestedTp: '52',
      globalSlCents: '44',
    });
    expect(r).toEqual({ sl: '44', tp: '' });
  });

  it('manual staged SL beats global SL', () => {
    const staged = { up: { sl: '41', tp: '' }, down: { sl: '', tp: '' } };
    const r = resolveStagedBuyBundleLevels('up', staged, {
      prefs: { autoFillSl: true, autoTpOnFill: false },
      suggestedSl: '38',
      suggestedTp: '52',
      globalSlCents: '44',
    });
    expect(r.sl).toBe('41');
  });

  it('auto-fills TP only when autoTpOnFill is enabled', () => {
    const r = resolveStagedBuyBundleLevels('up', empty, {
      prefs: { autoFillSl: true, autoTpOnFill: true },
      suggestedSl: '38',
      suggestedTp: '52',
    });
    expect(r).toEqual({ sl: '38', tp: '52' });
  });

  it('does not prefill TP on buy when operator already staged via Set TP on fill', () => {
    expect(
      shouldPrefillBuyBundleTpOnClick({
        autoTpOnFill: true,
        chaseTpCents: '92',
        stagedTp: '55',
        manualLane: true,
      }),
    ).toBe(false);
  });

  it('prefills TP on buy only when auto on, chase present, and field empty', () => {
    expect(
      shouldPrefillBuyBundleTpOnClick({
        autoTpOnFill: true,
        chaseTpCents: '52',
        stagedTp: '',
        manualLane: false,
      }),
    ).toBe(true);
    expect(
      shouldPrefillBuyBundleTpOnClick({
        autoTpOnFill: true,
        chaseTpCents: '92',
        stagedTp: '62.5',
        manualLane: false,
      }),
    ).toBe(false);
  });

  it('does not auto-fill chase TP when manual lane is set but field is empty', () => {
    const r = resolveStagedBuyBundleLevels('up', empty, {
      prefs: { autoFillSl: false, autoTpOnFill: true },
      suggestedSl: '38',
      suggestedTp: '91',
      manualTp: true,
    });
    expect(r.tp).toBe('');
  });

  it('keeps operator-staged values over suggestions', () => {
    const r = resolveStagedBuyBundleLevels('down', {
      up: { sl: '', tp: '' },
      down: { sl: '30', tp: '70' },
    }, {
      prefs: { autoFillSl: true, autoTpOnFill: true },
      suggestedSl: '38',
      suggestedTp: '52',
    });
    expect(r).toEqual({ sl: '30', tp: '70' });
  });
});
