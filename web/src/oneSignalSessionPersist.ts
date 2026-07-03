import type { UpdownShortcutAsset } from './lib/api';
import {
  DEFAULT_TP_GAIN_PCT,
  DEFAULT_WATCH_STOP_PCT,
  ONE_SIGNAL_DEFAULT_INTERVAL,
  ONE_SIGNAL_SESSION_MS,
  oneSignalSessionKey,
  type OneSignalSessionTradeRecord,
} from './oneSignalSessionAutoTrade';
import type { UpdownInterval } from './lib/api';

const ENABLED_KEY = 'pm_one_signal_session_enabled_v1';
const INTERVAL_KEY = 'pm_one_signal_session_interval_v1';
const TP_PCT_KEY = 'pm_one_signal_session_tp_pct_v1';
const WATCH_STOP_PCT_KEY = 'pm_one_signal_session_watch_stop_pct_v1';
const SESSION_STATE_KEY = 'pm_one_signal_session_state_v1';

export type OneSignalSessionConfig = {
  enabled: boolean;
  interval: UpdownInterval;
  tpGainPct: number;
  watchStopPct: number;
};

export type OneSignalSessionState = {
  sessionKey: string;
  trades: OneSignalSessionTradeRecord[];
};

function parseInterval(raw: string | null): UpdownInterval {
  if (raw === '5m' || raw === '15m' || raw === '1h' || raw === '4h' || raw === '1d') return raw;
  return ONE_SIGNAL_DEFAULT_INTERVAL;
}

function parsePct(raw: string | null, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(0.01, Math.min(0.2, n));
}

export function loadOneSignalSessionConfig(): OneSignalSessionConfig {
  if (typeof localStorage === 'undefined') {
    return {
      enabled: false,
      interval: ONE_SIGNAL_DEFAULT_INTERVAL,
      tpGainPct: DEFAULT_TP_GAIN_PCT,
      watchStopPct: DEFAULT_WATCH_STOP_PCT,
    };
  }
  try {
    return {
      enabled: localStorage.getItem(ENABLED_KEY) === '1',
      interval: parseInterval(localStorage.getItem(INTERVAL_KEY)),
      tpGainPct: parsePct(localStorage.getItem(TP_PCT_KEY), DEFAULT_TP_GAIN_PCT),
      watchStopPct: parsePct(localStorage.getItem(WATCH_STOP_PCT_KEY), DEFAULT_WATCH_STOP_PCT),
    };
  } catch {
    return {
      enabled: false,
      interval: ONE_SIGNAL_DEFAULT_INTERVAL,
      tpGainPct: DEFAULT_TP_GAIN_PCT,
      watchStopPct: DEFAULT_WATCH_STOP_PCT,
    };
  }
}

export function saveOneSignalSessionEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function saveOneSignalSessionInterval(interval: UpdownInterval): void {
  try {
    localStorage.setItem(INTERVAL_KEY, interval);
  } catch {
    /* ignore */
  }
}

export function saveOneSignalSessionTpGainPct(pct: number): void {
  try {
    localStorage.setItem(TP_PCT_KEY, String(pct));
  } catch {
    /* ignore */
  }
}

export function saveOneSignalSessionWatchStopPct(pct: number): void {
  try {
    localStorage.setItem(WATCH_STOP_PCT_KEY, String(pct));
  } catch {
    /* ignore */
  }
}

function parseTradeRecord(x: unknown): OneSignalSessionTradeRecord | null {
  if (typeof x !== 'object' || x == null) return null;
  const o = x as Record<string, unknown>;
  const asset = o.asset;
  if (asset !== 'btc' && asset !== 'eth' && asset !== 'sol' && asset !== 'hype') return null;
  if (typeof o.slug !== 'string' || !o.slug.trim()) return null;
  if (o.lane !== 'up' && o.lane !== 'down') return null;
  const nums = ['entry01', 'takeProfit01', 'watchStop01', 'sizeUsd', 'tradedAtMs'] as const;
  for (const k of nums) {
    if (typeof o[k] !== 'number' || !Number.isFinite(o[k] as number)) return null;
  }
  return {
    asset: asset as UpdownShortcutAsset,
    slug: o.slug as string,
    lane: o.lane as 'up' | 'down',
    entry01: o.entry01 as number,
    takeProfit01: o.takeProfit01 as number,
    watchStop01: o.watchStop01 as number,
    sizeUsd: o.sizeUsd as number,
    tradedAtMs: o.tradedAtMs as number,
  };
}

export function loadOneSignalSessionState(nowMs = Date.now()): OneSignalSessionState {
  const key = oneSignalSessionKey(nowMs);
  const empty: OneSignalSessionState = { sessionKey: key, trades: [] };
  if (typeof localStorage === 'undefined') return empty;
  try {
    const raw = localStorage.getItem(SESSION_STATE_KEY);
    if (!raw) return empty;
    const j = JSON.parse(raw) as unknown;
    if (typeof j !== 'object' || j == null) return empty;
    const o = j as Record<string, unknown>;
    if (o.sessionKey !== key) return empty;
    if (!Array.isArray(o.trades)) return empty;
    const trades = o.trades.map(parseTradeRecord).filter(Boolean) as OneSignalSessionTradeRecord[];
    return { sessionKey: key, trades };
  } catch {
    return empty;
  }
}

export function saveOneSignalSessionTrade(record: OneSignalSessionTradeRecord): OneSignalSessionState {
  const key = oneSignalSessionKey(record.tradedAtMs);
  const prev = loadOneSignalSessionState(record.tradedAtMs);
  const trades =
    prev.sessionKey === key
      ? [...prev.trades.filter((t) => t.asset !== record.asset), record]
      : [record];
  const state: OneSignalSessionState = { sessionKey: key, trades };
  try {
    localStorage.setItem(SESSION_STATE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
  return state;
}

export function hasTradedAssetThisSession(asset: UpdownShortcutAsset, nowMs = Date.now()): boolean {
  const state = loadOneSignalSessionState(nowMs);
  return state.trades.some((t) => t.asset === asset);
}

const inFlightAssets = new Set<UpdownShortcutAsset>();

export function markOneSignalAssetInFlight(asset: UpdownShortcutAsset): boolean {
  if (inFlightAssets.has(asset)) return false;
  inFlightAssets.add(asset);
  return true;
}

export function clearOneSignalAssetInFlight(asset: UpdownShortcutAsset): void {
  inFlightAssets.delete(asset);
}

export function sessionRemainingMs(nowMs = Date.now()): number {
  const bucket = Math.floor(nowMs / ONE_SIGNAL_SESSION_MS);
  const end = (bucket + 1) * ONE_SIGNAL_SESSION_MS;
  return Math.max(0, end - nowMs);
}
