import {
  price01ToCentsStr,
  resolveArmRiskCentsForEntry,
  spreadBracketFromFillPrice01,
  type BookTouchForArmRisk,
  type SignalRiskSnapshot,
} from './armRiskFromSignal';
import { formatBracketCentsFromRaw } from './bracketCentsInput';
import {
  bracketCentsFromAltModeDraft,
  bracketTriggerFromTotalUsdDraft,
  usdModeUsesTotal,
  type BracketInputMode,
  type BracketLegKind,
} from './lib/bracketLevelInput';

export type BracketInputDraftState = { draft: string; mode: BracketInputMode };

export const EMPTY_BRACKET_INPUT_DRAFT: BracketInputDraftState = { draft: '', mode: 'cents' };

export type BuyBundleLaneDraft = { sl: string; tp: string };

export type EmergencyStopBundlePrefs = {
  /** When true, empty emergency SL is filled from suggested spread/signal levels. */
  autoFillSl: boolean;
  /** When true, empty buy-bundle TP is filled from Targets assist (same as Set TP on fill). */
  autoTpOnFill: boolean;
};

export const EMERGENCY_STOP_BUNDLE_PREFS_KEY = 'pm:emergencyStopBundlePrefs:v1';

export const DEFAULT_EMERGENCY_STOP_BUNDLE_PREFS: EmergencyStopBundlePrefs = {
  autoFillSl: false,
  /** On by default — Targets assist quote TP fills the buy-bundle field and chases live until you edit. */
  autoTpOnFill: true,
};

export type QuoteAssistTargets = {
  tp01: number;
  stop01: number;
  tpCents: string;
  stopCents: string;
  quoteCents: string;
  spreadCents: string;
  sideLabel: string;
};

export function loadEmergencyStopBundlePrefs(): EmergencyStopBundlePrefs {
  try {
    const raw =
      typeof window !== 'undefined' ? window.localStorage.getItem(EMERGENCY_STOP_BUNDLE_PREFS_KEY) : null;
    if (!raw) return DEFAULT_EMERGENCY_STOP_BUNDLE_PREFS;
    const j = JSON.parse(raw) as Partial<EmergencyStopBundlePrefs>;
    return {
      autoFillSl: j.autoFillSl === true,
      /** Opt-out: missing key defaults to on so quote-assist TP auto-fills for existing installs. */
      autoTpOnFill: j.autoTpOnFill !== false,
    };
  } catch {
    return DEFAULT_EMERGENCY_STOP_BUNDLE_PREFS;
  }
}

/** Read staged emergency SL / optional TP for a buy lane (buy-tab fields only — not sell-tab bracket drafts). */
export function readStagedBuyBundleLevels(
  submitLane: 'up' | 'down',
  buyBundleByLane: { up: BuyBundleLaneDraft; down: BuyBundleLaneDraft },
): { sl: string; tp: string } {
  const bundle = buyBundleByLane[submitLane];
  return {
    sl: bundle.sl.trim(),
    tp: bundle.tp.trim(),
  };
}

export function bracketCentsEqual(a: string, b: string): boolean {
  const an = Number(a.trim());
  const bn = Number(b.trim());
  if (!Number.isFinite(an) || !Number.isFinite(bn)) return a.trim() === b.trim();
  return Math.abs(an - bn) < 0.001;
}

/** Targets (assist) card + emergency auto-fill — one spread bracket from executable quote. */
export function buildQuoteAssistTargets(args: {
  quote01: number | null | undefined;
  bestBid?: number | null;
  bestAsk?: number | null;
  sideLabel?: string;
}): QuoteAssistTargets | null {
  const quote = args.quote01;
  if (quote == null || !Number.isFinite(quote) || quote <= 0 || quote >= 1) return null;
  const bid = args.bestBid != null && args.bestBid > 0 && args.bestBid < 1 ? args.bestBid : null;
  const ask = args.bestAsk != null && args.bestAsk > 0 && args.bestAsk < 1 ? args.bestAsk : null;
  const spread01 = bid != null && ask != null ? Math.max(0, ask - bid) : 0;
  const { stopCents, tpCents } = spreadBracketFromFillPrice01(quote, { bestBid: bid, bestAsk: ask });
  const tp01 = Number(tpCents) / 100;
  const stop01 = Number(stopCents) / 100;
  return {
    tp01: Number.isFinite(tp01) ? tp01 : 0.01,
    stop01: Number.isFinite(stop01) ? stop01 : 0.01,
    tpCents,
    stopCents,
    quoteCents: price01ToCentsStr(quote),
    spreadCents: (spread01 * 100).toFixed(2),
    sideLabel: args.sideLabel ?? 'TP (sell)',
  };
}

export type AutoBundleChaseSource = 'signal' | 'spread' | 'quote';

/**
 * Pre-buy auto SL/TP chase target — signal card (when enabled + lane match),
 * else live Targets (assist) quote row, else spread from entry.
 */
export function resolveAutoBundleChaseLevels(args: {
  lane: 'up' | 'down';
  useSignalLevels: boolean;
  signal: SignalRiskSnapshot | null;
  quoteAssist: Pick<QuoteAssistTargets, 'tpCents' | 'stopCents' | 'quoteCents'> | null;
  entry01: number | null | undefined;
  bookTouch: BookTouchForArmRisk;
}): { tpCents: string; slCents: string; source: AutoBundleChaseSource } {
  const entry =
    args.entry01 != null && Number.isFinite(args.entry01) && args.entry01 > 0 && args.entry01 < 1
      ? args.entry01
      : args.quoteAssist?.quoteCents
        ? Number(args.quoteAssist.quoteCents) / 100
        : null;

  if (args.useSignalLevels && args.signal?.lane === args.lane && !args.signal.collapsed) {
    const signalCents = resolveArmRiskCentsForEntry({
      entry01: entry ?? args.signal.entry01,
      lane: args.lane,
      bookTouch: args.bookTouch,
      signal: args.signal,
      useSignalLevels: true,
    });
    if (signalCents.source === 'signal') {
      return { tpCents: signalCents.tpCents, slCents: signalCents.stopCents, source: 'signal' };
    }
  }

  /** Live executable quote row — updates every book tick (Targets assist). */
  const quoteTp = args.quoteAssist?.tpCents.trim() ?? '';
  const quoteSl = args.quoteAssist?.stopCents.trim() ?? '';
  if (quoteTp || quoteSl) {
    return { tpCents: quoteTp, slCents: quoteSl, source: 'quote' };
  }

  if (entry != null && entry > 0 && entry < 1) {
    const spread = spreadBracketFromFillPrice01(entry, args.bookTouch);
    return { tpCents: spread.tpCents, slCents: spread.stopCents, source: 'spread' };
  }

  return { tpCents: '', slCents: '', source: 'spread' };
}

/** Pre-buy auto SL/TP: chase Targets assist until operator edits or buy lock. */
export function shouldChaseAutoBundleLevel(args: {
  manualLane: boolean;
  deskLocked: boolean;
  quoteCents: string;
  curCents: string;
}): boolean {
  if (args.deskLocked || args.manualLane) return false;
  const quote = args.quoteCents.trim();
  if (!quote) return false;
  const cur = args.curCents.trim();
  if (!cur) return true;
  return !bracketCentsEqual(cur, quote);
}

/** @deprecated use shouldChaseAutoBundleLevel */
export const shouldChaseAutoBundleTp = shouldChaseAutoBundleLevel;

/** Buy click may chase live TP only when auto is on and the operator has not staged a manual level. */
export function shouldPrefillBuyBundleTpOnClick(args: {
  autoTpOnFill: boolean;
  chaseTpCents: string;
  stagedTp: string;
  manualLane: boolean;
}): boolean {
  if (!args.autoTpOnFill) return false;
  if (!args.chaseTpCents.trim()) return false;
  if (args.stagedTp.trim()) return false;
  if (args.manualLane) return false;
  return true;
}

/** Buy click may chase live SL only when auto is on and the operator has not staged a manual level. */
export function shouldPrefillBuyBundleSlOnClick(args: {
  autoFillSl: boolean;
  chaseSlCents: string;
  stagedSl: string;
  manualLane: boolean;
}): boolean {
  if (!args.autoFillSl) return false;
  if (!args.chaseSlCents.trim()) return false;
  if (args.stagedSl.trim()) return false;
  if (args.manualLane) return false;
  return true;
}

/** Commit in-progress bracket draft before buy — converts % / $ drafts to trigger ¢. */
export function flushPendingBracketDraft(args: {
  draft: string;
  mode: BracketInputMode;
  committed: string;
  kind: BracketLegKind;
  ref01: number | null;
  shares?: number | null;
}): string | null {
  const draft = args.draft.trim();
  if (!draft) return null;

  let centsStr: string | null = null;
  if (args.mode === 'cents') {
    if (args.ref01 != null && usdModeUsesTotal(args.shares)) {
      const usdCommit = bracketTriggerFromTotalUsdDraft({
        raw: draft,
        kind: args.kind,
        ref01: args.ref01,
        shares: args.shares!,
      });
      centsStr = usdCommit?.centsStr ?? null;
    }
    if (centsStr == null) centsStr = formatBracketCentsFromRaw(draft);
  } else if (args.ref01 != null) {
    centsStr = bracketCentsFromAltModeDraft({
      mode: args.mode,
      draft,
      kind: args.kind,
      ref01: args.ref01,
      shares: args.shares,
    });
  }

  if (centsStr == null) return null;
  if (centsStr === args.committed.trim()) return null;
  return centsStr;
}

/** @deprecated Use flushPendingBracketDraft — cents-only flush misreads % / $ drafts. */
export function flushPendingBracketCentsDraft(args: {
  draft: string;
  committed: string;
}): string | null {
  return flushPendingBracketDraft({
    draft: args.draft,
    mode: 'cents',
    committed: args.committed,
    kind: 'sl',
    ref01: null,
  });
}

/** Merge operator-staged levels with auto-fill prefs — pre-buy only; empty fields get one-time hints, never overrides manual ¢. */
export function resolveStagedBuyBundleLevels(
  submitLane: 'up' | 'down',
  buyBundleByLane: { up: BuyBundleLaneDraft; down: BuyBundleLaneDraft },
  opts: {
    prefs: EmergencyStopBundlePrefs;
    suggestedSl: string;
    suggestedTp: string;
    manualSl?: boolean;
    manualTp?: boolean;
    /** Global stop (¢ below fill) — fills empty SL when set. */
    globalSlCents?: string | null;
  },
): { sl: string; tp: string } {
  const staged = readStagedBuyBundleLevels(submitLane, buyBundleByLane);
  const suggestedSl = opts.suggestedSl.trim();
  const suggestedTp = opts.suggestedTp.trim();
  const globalSl = opts.globalSlCents?.trim() ?? '';
  return {
    sl:
      staged.sl ||
      globalSl ||
      (opts.prefs.autoFillSl && !opts.manualSl ? suggestedSl : ''),
    tp: staged.tp || (opts.prefs.autoTpOnFill && !opts.manualTp ? suggestedTp : ''),
  };
}
