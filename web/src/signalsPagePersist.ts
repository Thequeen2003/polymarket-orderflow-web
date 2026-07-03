/**
 * Browser persistence for the Polymarket Signals desk only (ack + directive journal).
 * Keyed by market slug so a refresh keeps the same round's operator state.
 */

import type { DirectiveJournal, JournalEntry } from './directiveJournal';
import { refreshJournalStats, resetJournal } from './directiveJournal';
import type { DirectiveAction, DirectiveUrgency } from './tradeDirective';
import {
  isTakeSignalStrategyId,
  normalizeTakeSignalStrategyIds,
  type TakeSignalStrategyId,
} from './takeSignalStrategy';

const STORAGE_V = 1 as const;
const PREFIX = 'pm_signals_desk_v1:';
const AUTO_TRADE_DO_THIS_NOW_KEY = 'pm_signals_auto_trade_do_this_now_v1';
const AUTO_TRADE_SIZE_SHARES_KEY = 'pm_signals_auto_trade_size_shares_v1';
const AUTO_TRADE_ARM_SL_TP_KEY = 'pm_signals_auto_trade_arm_sl_tp_v1';
const AUTO_TRADE_EXIT_ON_SIGNAL_KEY = 'pm_signals_auto_trade_exit_on_signal_v1';
const AUTO_TRADE_EXIT_MIN_PRESSURE_KEY = 'pm_signals_auto_trade_exit_min_pressure_v1';
const TAKE_SIGNAL_STRATEGIES_KEY = 'pm_signals_take_strategies_v1';

export const DEFAULT_AUTO_TRADE_SIZE_SHARES = 10;
export const DEFAULT_AUTO_EXIT_MIN_PRESSURE = 65;

/** After this long without a save, do not restore "I hold" — avoids looking like UP self-selected after a break. */
export const SIGNALS_DESK_ACK_STALE_MS = 3 * 60 * 60 * 1000;

export type SignalsDeskPersisted = {
  v: typeof STORAGE_V;
  savedAt: number;
  manualPositionLane: 'up' | 'down' | null;
  signalTakenAtMs: number | null;
  /** CLOB touch mid (0–1) for the lane you tapped on **I hold** — for “Up @ 95¢” context. */
  signalTakenMid01: number | null;
  journal: DirectiveJournal;
};

function storageKey(slug: string): string {
  return PREFIX + encodeURIComponent(slug.trim().slice(0, 400));
}

const ACTIONS = new Set<DirectiveAction>([
  'INITIATE',
  'ADD',
  'HOLD',
  'TRIM',
  'EXIT',
  'FLIP',
  'STAND_DOWN',
]);

const URGENCIES = new Set<DirectiveUrgency>(['now', 'soon', 'patient']);

function isJournalEntry(x: unknown): x is JournalEntry {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.ts !== 'number' || !Number.isFinite(o.ts)) return false;
  if (typeof o.action !== 'string' || !ACTIONS.has(o.action as DirectiveAction)) return false;
  const lane = o.lane;
  if (lane != null && lane !== 'up' && lane !== 'down') return false;
  if (typeof o.urgency !== 'string' || !URGENCIES.has(o.urgency as DirectiveUrgency)) return false;
  if (typeof o.recommendedSize !== 'number' || !Number.isFinite(o.recommendedSize)) return false;
  if (o.edgePerShareUsd != null && typeof o.edgePerShareUsd !== 'number') return false;
  if (o.agreementScore != null && typeof o.agreementScore !== 'number') return false;
  if (typeof o.headline !== 'string') return false;
  return true;
}

function isJournal(x: unknown): x is DirectiveJournal {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o.entries)) return false;
  if (o.entries.length > 80) return false;
  for (const e of o.entries) {
    if (!isJournalEntry(e)) return false;
  }
  if (typeof o.stats !== 'object' || o.stats === null) return false;
  return true;
}

function parsePayload(raw: string): SignalsDeskPersisted | null {
  let j: unknown;
  try {
    j = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof j !== 'object' || j === null) return null;
  const o = j as Record<string, unknown>;
  if (o.v !== STORAGE_V) return null;
  if (typeof o.savedAt !== 'number' || !Number.isFinite(o.savedAt)) return null;
  const ml = o.manualPositionLane;
  if (ml != null && ml !== 'up' && ml !== 'down') return null;
  if (o.signalTakenAtMs != null && typeof o.signalTakenAtMs !== 'number') return null;
  if (!isJournal(o.journal)) return null;
  let signalTakenMid01: number | null = null;
  const rawMid = o.signalTakenMid01;
  if (rawMid != null && typeof rawMid === 'number' && Number.isFinite(rawMid) && rawMid > 0 && rawMid < 1) {
    signalTakenMid01 = rawMid;
  }
  return {
    v: STORAGE_V,
    savedAt: o.savedAt,
    manualPositionLane: (ml ?? null) as 'up' | 'down' | null,
    signalTakenAtMs: o.signalTakenAtMs == null ? null : (o.signalTakenAtMs as number),
    signalTakenMid01,
    journal: o.journal,
  };
}

export function loadSignalsDeskPersist(slug: string | null | undefined): SignalsDeskPersisted | null {
  if (slug == null || typeof slug !== 'string' || !slug.trim()) return null;
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storageKey(slug));
    if (raw == null || raw === '') return null;
    return parsePayload(raw);
  } catch {
    return null;
  }
}

export function saveSignalsDeskPersist(slug: string | null | undefined, payload: Omit<SignalsDeskPersisted, 'v' | 'savedAt'>): void {
  if (slug == null || typeof slug !== 'string' || !slug.trim()) return;
  if (typeof localStorage === 'undefined') return;
  const full: SignalsDeskPersisted = {
    v: STORAGE_V,
    savedAt: Date.now(),
    ...payload,
  };
  try {
    localStorage.setItem(storageKey(slug), JSON.stringify(full));
  } catch {
    // Quota or private mode — ignore.
  }
}

export function clearSignalsDeskPersist(slug: string | null | undefined): void {
  if (slug == null || typeof slug !== 'string' || !slug.trim()) return;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(storageKey(slug));
  } catch {
    // ignore
  }
}

/** Clear **I hold · UP/DOWN** tags for every saved Signals desk market (keeps directive journal). */
export function clearAllSignalsDeskHolds(): number {
  if (typeof localStorage === 'undefined') return 0;
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
  } catch {
    return 0;
  }
  let n = 0;
  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const p = parsePayload(raw);
      if (!p || p.manualPositionLane == null) continue;
      const next: SignalsDeskPersisted = {
        ...p,
        savedAt: Date.now(),
        manualPositionLane: null,
        signalTakenAtMs: null,
        signalTakenMid01: null,
      };
      localStorage.setItem(key, JSON.stringify(next));
      n += 1;
    } catch {
      // ignore single key
    }
  }
  return n;
}

/** For `useState` initializers — safe on SSR (no window). */
export function loadAutoTradeOnDoThisNow(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(AUTO_TRADE_DO_THIS_NOW_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveAutoTradeOnDoThisNow(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(AUTO_TRADE_DO_THIS_NOW_KEY, enabled ? '1' : '0');
  } catch {
    // ignore
  }
}

export function loadAutoTradeSizeShares(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_AUTO_TRADE_SIZE_SHARES;
  try {
    const raw = localStorage.getItem(AUTO_TRADE_SIZE_SHARES_KEY);
    if (!raw) return DEFAULT_AUTO_TRADE_SIZE_SHARES;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_AUTO_TRADE_SIZE_SHARES;
    return Math.min(100_000, Math.max(0.0001, n));
  } catch {
    return DEFAULT_AUTO_TRADE_SIZE_SHARES;
  }
}

export function saveAutoTradeSizeShares(shares: number): void {
  if (typeof localStorage === 'undefined') return;
  const n = Number(shares);
  if (!Number.isFinite(n) || n <= 0) return;
  try {
    localStorage.setItem(AUTO_TRADE_SIZE_SHARES_KEY, String(Math.min(100_000, n)));
  } catch {
    // ignore
  }
}

export function loadAutoTradeArmSlTp(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(AUTO_TRADE_ARM_SL_TP_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveAutoTradeArmSlTp(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(AUTO_TRADE_ARM_SL_TP_KEY, enabled ? '1' : '0');
  } catch {
    // ignore
  }
}

export function loadAutoTradeExitOnSignal(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(AUTO_TRADE_EXIT_ON_SIGNAL_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveAutoTradeExitOnSignal(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(AUTO_TRADE_EXIT_ON_SIGNAL_KEY, enabled ? '1' : '0');
  } catch {
    // ignore
  }
}

export function loadAutoTradeExitMinPressure(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_AUTO_EXIT_MIN_PRESSURE;
  try {
    const raw = localStorage.getItem(AUTO_TRADE_EXIT_MIN_PRESSURE_KEY);
    if (!raw) return DEFAULT_AUTO_EXIT_MIN_PRESSURE;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_AUTO_EXIT_MIN_PRESSURE;
    return Math.min(100, Math.max(0, Math.round(n)));
  } catch {
    return DEFAULT_AUTO_EXIT_MIN_PRESSURE;
  }
}

export function saveAutoTradeExitMinPressure(pressure: number): void {
  if (typeof localStorage === 'undefined') return;
  const n = Number(pressure);
  if (!Number.isFinite(n)) return;
  try {
    localStorage.setItem(AUTO_TRADE_EXIT_MIN_PRESSURE_KEY, String(Math.min(100, Math.max(0, Math.round(n)))));
  } catch {
    // ignore
  }
}

/** Active take-signal strategy filters (empty = raw card plan only). */
export function loadTakeSignalStrategyIds(): TakeSignalStrategyId[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(TAKE_SIGNAL_STRATEGIES_KEY);
    if (!raw) return [];
    const j = JSON.parse(raw) as unknown;
    if (!Array.isArray(j)) return [];
    return normalizeTakeSignalStrategyIds(j.filter((x): x is string => typeof x === 'string'));
  } catch {
    return [];
  }
}

export function saveTakeSignalStrategyIds(ids: readonly TakeSignalStrategyId[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(TAKE_SIGNAL_STRATEGIES_KEY, JSON.stringify(normalizeTakeSignalStrategyIds(ids)));
  } catch {
    // ignore
  }
}

export function toggleTakeSignalStrategyId(
  current: readonly TakeSignalStrategyId[],
  id: TakeSignalStrategyId,
  enabled: boolean,
): TakeSignalStrategyId[] {
  if (!isTakeSignalStrategyId(id)) return normalizeTakeSignalStrategyIds(current);
  const set = new Set(current);
  if (enabled) set.add(id);
  else set.delete(id);
  return normalizeTakeSignalStrategyIds([...set]);
}

export function readSignalsDeskBoot(slug: string | null | undefined): {
  manualPositionLane: 'up' | 'down' | null;
  signalTakenAtMs: number | null;
  signalTakenMid01: number | null;
  journal: DirectiveJournal;
} {
  const p = loadSignalsDeskPersist(slug);
  if (!p) {
    return { manualPositionLane: null, signalTakenAtMs: null, signalTakenMid01: null, journal: resetJournal() };
  }
  const stale = Date.now() - p.savedAt > SIGNALS_DESK_ACK_STALE_MS;
  return {
    manualPositionLane: stale ? null : p.manualPositionLane,
    signalTakenAtMs: stale ? null : p.signalTakenAtMs,
    signalTakenMid01: stale ? null : p.signalTakenMid01,
    journal: refreshJournalStats(p.journal, Date.now()),
  };
}
