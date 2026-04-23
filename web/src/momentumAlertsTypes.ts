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

/** One-click: ~65¢ entry band → ~70¢ target (momentum rip). Mids are 0–1. */
export function tradePlan65To70(): TradePlan {
  return {
    ...defaultTradePlan(),
    plannedEntry: '0.65',
    entryRangeLow: '0.64',
    entryRangeHigh: '0.66',
    targetSell: '0.70',
    riskLevel: 'med',
    doNotEnter: 'Very wide spread, giant ask wall, or weak follow-through on tape',
    momentumThreshold: '0.012',
  };
}

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
  /** In planned entry band + positive momentum (rip starter). */
  | 'momentum_catch'
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
  momentum_catch: true,
  weak_follow: true,
  do_not_enter_signal: true,
  context: true,
});

export type AlertSeverity = 'info' | 'warn' | 'critical';

export type AlertCooldowns = Record<AlertKind, number>;
export const defaultAlertCooldowns = (): AlertCooldowns => ({
  momentum_start: 45_000,
  momentum_slow: 45_000,
  bid_wall: 45_000,
  ask_wall: 45_000,
  bids_pulled: 45_000,
  asks_eaten: 45_000,
  spoof_suspect: 60_000,
  near_entry: 60_000,
  near_target: 60_000,
  momentum_catch: 32_000,
  weak_follow: 60_000,
  do_not_enter_signal: 60_000,
  context: 45_000,
});

export type AlertEvent = {
  id: string;
  t: number;
  slug: string;
  kind: AlertKind;
  message: string;
  severity?: AlertSeverity;
  /** 0–100, deterministic. */
  confidenceScore?: number;
  /** Short list of quality flags that explain why confidence is low. */
  flags?: { id: string; label: string; severity: 'info' | 'warn' }[];
  /** Structured “why” details (show in expanded view). */
  drivers?: { key: string; label: string; value: string; raw?: number; delta?: string }[];
};

export type EntryVerdict = {
  headline: string;
  tone: 'good' | 'wait' | 'bad' | 'neutral';
  bullets: string[];
};

/** Tuned rules for 4¢ long scalp mode (Momentum + Alerts). */
export type UpScalpSettings = {
  /** Net profit target in cents (typically 4). */
  targetNetCents: number;
  /** Reject when top-of-book spread (cents) exceeds this. */
  maxSpreadCents: number;
  /** Max acceptable required gross move (cents) from estimator — above this is AVOID. */
  maxRequiredGrossCents: number;
  /** Min price distance (0–1, same as mid) from mid to first notable ask wall; below → WAIT. */
  minAskWallDistance: number;
  minConfidence: number;
  /** Min positive slope (/s) for long scalp. */
  minMomentum: number;
  /** Share size for net+4¢ feasibility (must match poll + card). */
  refShares: number;
};

export const defaultUpScalpSettings = (): UpScalpSettings => ({
  targetNetCents: 4,
  maxSpreadCents: 5,
  maxRequiredGrossCents: 12,
  minAskWallDistance: 0.012,
  minConfidence: 55,
  minMomentum: 0.015,
  refShares: 100,
});

export type ScalpRowStatus = 'pass' | 'warn' | 'fail';

export type ScalpVerdictRow = {
  id: 'fill' | 'momentum' | 'pressure' | 'resistance' | 'net4c';
  label: string;
  status: ScalpRowStatus;
  detail: string;
};

export type ScalpVerdictState = 'READY' | 'WAIT' | 'AVOID';

export type ScalpVerdict = {
  state: ScalpVerdictState;
  headline: string;
  rows: ScalpVerdictRow[];
  tickConfidence: number | null;
};
