/**
 * Live trading policy from `api/.env` (and optional repo `.env`).
 *
 * When `ENABLE_LIVE_TRADING=true`, `POLYMARKET_LIVE_CONFIRM` matches, and CLOB keys
 * validate, live orders use the in-process CLOB client unless `POLYMARKET_LIVE_ORDERS_VIA`
 * explicitly requests Bullpen.
 */
import { getTradingConfigFromEnv } from './polymarketTrading.js';

/** Case-insensitive match for the operator confirmation line in `api/.env`. */
export const LIVE_TRADING_CONFIRM_PHRASE = 'I understand the risks of live trading.';

export function envFlagTrue(raw: string | undefined): boolean {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function envFlagFalse(raw: string | undefined): boolean {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

export function isEnableLiveTrading(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagTrue(env.ENABLE_LIVE_TRADING);
}

export function isLiveTradingConfirmed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.POLYMARKET_LIVE_CONFIRM ?? '').trim();
  if (!raw) return false;
  if (envFlagTrue(raw)) return true;
  return raw.toLowerCase() === LIVE_TRADING_CONFIRM_PHRASE.toLowerCase();
}

export function liveTradingGate(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; error: string; hint: string } {
  if (!isEnableLiveTrading(env)) {
    return {
      ok: false,
      error: 'live_trading_disabled',
      hint: 'Set ENABLE_LIVE_TRADING=true in api/.env to allow real-money orders.',
    };
  }
  if (!isLiveTradingConfirmed(env)) {
    return {
      ok: false,
      error: 'live_trading_not_confirmed',
      hint: `Set POLYMARKET_LIVE_CONFIRM="${LIVE_TRADING_CONFIRM_PHRASE}" in api/.env.`,
    };
  }
  return { ok: true };
}

/** True when CLOB keys in env are valid (does not check live gate). */
export function hasClobTradingConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return getTradingConfigFromEnv(env).ok;
}

/**
 * Execution path for `POST /api/trade/*`.
 * Default Bullpen unless env explicitly picks CLOB or file enables live CLOB with keys.
 */
export function liveOrdersViaBullpen(env: NodeJS.ProcessEnv = process.env): boolean {
  const via = String(env.POLYMARKET_LIVE_ORDERS_VIA ?? '').trim().toLowerCase();
  if (via === 'clob') return false;
  if (via === 'bullpen') return true;
  if (via !== '') return true;
  if (envFlagFalse(env.POLYMARKET_USE_BULLPEN)) return false;
  if (liveTradingGate(env).ok && hasClobTradingConfig(env)) return false;
  return true;
}

export function polymarketUseBullpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagTrue(env.POLYMARKET_USE_BULLPEN) || liveOrdersViaBullpen(env);
}

export function liveTradingEnvSummary(env: NodeJS.ProcessEnv = process.env): {
  enable_live_trading: boolean;
  live_trading_confirmed: boolean;
  live_orders_via: 'bullpen' | 'clob';
  clob_config_ready: boolean;
  polymarket_clob_sdk: string | null;
} {
  return {
    enable_live_trading: isEnableLiveTrading(env),
    live_trading_confirmed: isLiveTradingConfirmed(env),
    live_orders_via: liveOrdersViaBullpen(env) ? 'bullpen' : 'clob',
    clob_config_ready: hasClobTradingConfig(env),
    polymarket_clob_sdk: String(env.POLYMARKET_CLOB_SDK ?? '').trim() || null,
  };
}
