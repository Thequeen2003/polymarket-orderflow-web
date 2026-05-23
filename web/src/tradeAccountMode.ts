/** Shared paper vs live mode for Trade panel, Tracking, and App chrome. */
export const TRADE_ACCOUNT_MODE_LS = 'pm:tradeAccountMode:v1';
export const TRADE_ACCOUNT_MODE_EVENT = 'pm:trade-account-mode';

const LEGACY_TRACKING = 'pm:trackingPortfolioMode:v1';
const LEGACY_SIGNALS = 'pm:signalsTradeAccountMode:v1';

export type TradeAccountMode = 'live' | 'paper';

export function loadTradeAccountMode(): TradeAccountMode {
  try {
    const v = window.localStorage.getItem(TRADE_ACCOUNT_MODE_LS);
    if (v === 'live' || v === 'paper') return v;
    const t = window.localStorage.getItem(LEGACY_TRACKING);
    if (t === 'live' || t === 'paper') {
      saveTradeAccountMode(t);
      return t;
    }
    const s = window.localStorage.getItem(LEGACY_SIGNALS);
    if (s === 'live' || s === 'paper') {
      saveTradeAccountMode(s);
      return s;
    }
  } catch {
    /* ignore */
  }
  return 'paper';
}

export function saveTradeAccountMode(mode: TradeAccountMode): void {
  try {
    window.localStorage.setItem(TRADE_ACCOUNT_MODE_LS, mode);
    window.localStorage.setItem(LEGACY_TRACKING, mode);
    window.localStorage.setItem(LEGACY_SIGNALS, mode);
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent(TRADE_ACCOUNT_MODE_EVENT, { detail: { mode } }));
  } catch {
    /* ignore */
  }
}
