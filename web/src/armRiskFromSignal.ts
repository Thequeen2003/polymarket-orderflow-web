/**
 * Arm SL/TP after a buy fill: prefer trade-card / signal brackets when the fill
 * is near the signal entry; otherwise fall back to a spread-based scalp bracket.
 */

import {
  formatCentsFrom01,
  formatCentsFromNumber,
  roundPrice01ToCent,
} from './displayCents';
import type { TradeLevels } from './tradeLevels';

export const BPX_SIGNAL_RISK_LEVELS_EVENT = 'bpx-signal-risk-levels';

export type SignalRiskLevelsDetail = {
  slug?: string;
  lane: 'up' | 'down';
  /** Entry the card quoted (or operator ack mid). */
  entry01: number;
  takeProfit01: number;
  stopLoss01: number;
  collapsed?: boolean;
};

export type SignalRiskSnapshot = SignalRiskLevelsDetail & {
  updatedAtMs: number;
};

export type BookTouchForArmRisk = { bestBid?: number | null; bestAsk?: number | null } | null | undefined;

export type ArmRiskCentsSource = 'signal' | 'spread';

const DEFAULT_ENTRY_MATCH_CENTS = 4;

function clamp01(x: number): number {
  return Math.max(0.01, Math.min(0.99, x));
}

function roundPrice01(x: number): number {
  return roundPrice01ToCent(x);
}

/** Whole cents string for bracket fields and desk copy. */
export function price01ToCentsStr(price01: number): string {
  return formatCentsFrom01(price01);
}

/** UI / desk bracket fields — whole cents only. */
export function formatBracketCentsFrom01(price01: number): string {
  return formatCentsFrom01(price01);
}

export function formatBracketCentsFromNumber(cents: number): string {
  return formatCentsFromNumber(cents);
}

export function cloneSignalRiskSnapshot(snap: SignalRiskSnapshot | null): SignalRiskSnapshot | null {
  if (!snap) return null;
  return { ...snap };
}

/** True when fill is within `maxDeltaCents` of the signal entry anchor. */
export function fillMatchesSignalEntry(
  fillPrice01: number,
  signalEntry01: number,
  maxDeltaCents = DEFAULT_ENTRY_MATCH_CENTS,
): boolean {
  if (!Number.isFinite(fillPrice01) || !Number.isFinite(signalEntry01)) return false;
  if (fillPrice01 <= 0 || fillPrice01 >= 1) return false;
  if (signalEntry01 <= 0 || signalEntry01 >= 1) return false;
  return Math.abs(fillPrice01 - signalEntry01) * 100 <= maxDeltaCents;
}

export function tradeLevelsToRiskCents(levels: TradeLevels): { tpCents: string; stopCents: string } | null {
  if (levels.collapsed) return null;
  return {
    tpCents: price01ToCentsStr(levels.takeProfit),
    stopCents: price01ToCentsStr(levels.stopLoss),
  };
}

export function signalSnapshotToRiskCents(snapshot: SignalRiskSnapshot): { tpCents: string; stopCents: string } | null {
  if (snapshot.collapsed) return null;
  const tp = snapshot.takeProfit01;
  const sl = snapshot.stopLoss01;
  if (!Number.isFinite(tp) || !Number.isFinite(sl) || tp <= 0 || sl <= 0) return null;
  return {
    tpCents: price01ToCentsStr(tp),
    stopCents: price01ToCentsStr(sl),
  };
}

/** Spread-based bracket used when signal levels are unavailable or fill is off-entry. */
export function spreadBracketFromFillPrice01(
  entry01: number,
  touch: BookTouchForArmRisk,
): { stopCents: string; tpCents: string } {
  const e = roundPrice01(clamp01(entry01));
  const bid = touch?.bestBid != null && touch.bestBid > 0 ? roundPrice01(touch.bestBid) : null;
  const ask = touch?.bestAsk != null && touch.bestAsk > 0 ? roundPrice01(touch.bestAsk) : null;
  const spread01 = bid != null && ask != null ? Math.max(0, ask - bid) : 0;
  const tick01 = 0.001;
  const base = Math.max(tick01 * 3, spread01 || tick01 * 5);
  const tp01 = Math.min(0.99, Math.max(0.01, e + base * 3));
  const stop01 = Math.max(0.01, Math.min(0.99, e - base * 2));
  return { stopCents: price01ToCentsStr(stop01), tpCents: price01ToCentsStr(tp01) };
}

/**
 * TP/SL cents for arming now (toggle / open position) — uses card levels when lane matches;
 * does not require fill ≈ entry.
 */
export function resolveArmRiskCentsForEntry(input: {
  entry01: number;
  lane: 'up' | 'down';
  bookTouch: BookTouchForArmRisk;
  signal: SignalRiskSnapshot | null;
  useSignalLevels: boolean;
}): { tpCents: string; stopCents: string; source: ArmRiskCentsSource } {
  const entry = roundPrice01(clamp01(input.entry01));
  const spread = spreadBracketFromFillPrice01(entry, input.bookTouch);

  if (!input.useSignalLevels || !input.signal) {
    return { ...spread, source: 'spread' };
  }
  if (input.signal.lane !== input.lane || input.signal.collapsed) {
    return { ...spread, source: 'spread' };
  }
  const signalCents = signalSnapshotToRiskCents(input.signal);
  if (!signalCents) {
    return { ...spread, source: 'spread' };
  }
  return { ...signalCents, source: 'signal' };
}

/**
 * Pick TP/SL cents to arm after a buy fill.
 * When `useSignalLevels` is on and the card lane matches, always use the signal card TP/SL
 * (desk “Take signal” intent) — not a spread bracket because fill slipped a few cents.
 */
export function resolveArmRiskCentsAfterBuy(input: {
  fillPrice01: number;
  lane: 'up' | 'down';
  bookTouch: BookTouchForArmRisk;
  signal: SignalRiskSnapshot | null;
  useSignalLevels: boolean;
  /** When false, require fill ≈ signal entry before using card levels (legacy). */
  trustSignalCardRegardlessOfFill?: boolean;
  maxEntryDeltaCents?: number;
}): { tpCents: string; stopCents: string; source: ArmRiskCentsSource } {
  const entry = roundPrice01(clamp01(input.fillPrice01));
  const spread = spreadBracketFromFillPrice01(entry, input.bookTouch);

  if (!input.useSignalLevels || !input.signal) {
    return { ...spread, source: 'spread' };
  }

  if (input.signal.lane !== input.lane || input.signal.collapsed) {
    return { ...spread, source: 'spread' };
  }

  const signalCents = signalSnapshotToRiskCents(input.signal);
  if (!signalCents) {
    return { ...spread, source: 'spread' };
  }

  if (input.trustSignalCardRegardlessOfFill !== false) {
    return { ...signalCents, source: 'signal' };
  }

  const maxCents = input.maxEntryDeltaCents ?? DEFAULT_ENTRY_MATCH_CENTS;
  if (!fillMatchesSignalEntry(entry, input.signal.entry01, maxCents)) {
    return { ...spread, source: 'spread' };
  }

  return { ...signalCents, source: 'signal' };
}

export function dispatchSignalRiskLevels(detail: SignalRiskLevelsDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(BPX_SIGNAL_RISK_LEVELS_EVENT, { detail }));
}
