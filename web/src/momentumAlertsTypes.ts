/** Watchlist + trade plan + alert prefs for Momentum + Alerts tab. */

export type WatchlistEntry = {
  id: string;
  slug: string;
  label: string;
  outcomeIndex: number;
  /** Filled after first successful markets/get */
  tokenIds?: string[];
};

export type RiskLevel = 'low' | 'med' | 'high' | '';

export type TradePlan = {
  plannedEntry: string;
  entryRangeLow: string;
  entryRangeHigh: string;
  targetSell: string;
  riskLevel: RiskLevel;
  doNotEnter: string;
  momentumThreshold: string;
};

export const defaultTradePlan = (): TradePlan => ({
  plannedEntry: '',
  entryRangeLow: '',
  entryRangeHigh: '',
  targetSell: '',
  riskLevel: 'med',
  doNotEnter: '',
  momentumThreshold: '0.015',
});

export type AlertKind =
  | 'momentum_start'
  | 'momentum_slow'
  | 'bid_wall'
  | 'ask_wall'
  | 'bids_pulled'
  | 'asks_eaten'
  | 'spoof_suspect'
  | 'near_entry'
  | 'near_target'
  | 'weak_follow'
  | 'do_not_enter_signal'
  | 'context';

export type AlertPrefs = Record<AlertKind, boolean>;

export const defaultAlertPrefs = (): AlertPrefs => ({
  momentum_start: true,
  momentum_slow: true,
  bid_wall: true,
  ask_wall: true,
  bids_pulled: true,
  asks_eaten: true,
  spoof_suspect: true,
  near_entry: true,
  near_target: true,
  weak_follow: true,
  do_not_enter_signal: true,
  context: true,
});

export type AlertEvent = {
  id: string;
  t: number;
  slug: string;
  kind: AlertKind;
  message: string;
};

export type EntryVerdict = {
  headline: string;
  tone: 'good' | 'wait' | 'bad' | 'neutral';
  bullets: string[];
};
