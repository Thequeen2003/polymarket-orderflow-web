/**
 * Dispatched by `PtbOpportunityModeChart` when the sectional switch-forecaster transitions
 * (e.g. WAIT → SWITCH_INCOMING, STAY_IN → EXIT). Other panels (SignalsTradePanel) listen
 * for this and surface a toast so the user gets notified about regime changes on
 * 1h / 4h markets in real time.
 */
export const SECTIONAL_DECISION_EVENT = 'sectional-decision-event';

export type SectionalDecisionDetail = {
  /** Which slug fired the event — so listeners can ignore stale slugs. */
  slug: string;
  status: 'GO_IN' | 'STAY_IN' | 'SWITCH_INCOMING' | 'EXIT' | 'WAIT';
  lane: 'up' | 'down' | null;
  /** Section-window drift (see `SwitchForecast.driftLane`). */
  driftLane: 'up' | 'down' | null;
  incomingLane: 'up' | 'down' | null;
  confidence: 'HIGH' | 'MED' | 'LOW';
  etaSec: number | null;
  headline: string;
  reason: string;
};

/**
 * Dispatched only when a SWITCH_INCOMING / EXIT / GO_IN actually *confirms* — i.e. the
 * forecaster has held HIGH confidence for the dwell window (or all three signals
 * triple-confirm). UI listens for this to show a big "BOOM" overlay + a louder toast.
 */
export const SECTIONAL_BOOM_EVENT = 'sectional-boom-event';

export type SectionalBoomKind = 'OPPOSITE_INCOMING' | 'EXIT_NOW' | 'TRIPLE_CONFIRM_ENTRY';

export type SectionalBoomDetail = {
  slug: string;
  kind: SectionalBoomKind;
  /** Lane this boom is *about* (the lane to enter, exit, or that's coming in). */
  lane: 'up' | 'down';
  /** Pre-formatted display labels (UP/DOWN outcome names) so toast can use them directly. */
  laneLabel: string;
  oppositeLabel: string;
  /** ETA from the forecaster, if any. */
  etaSec: number | null;
  /** Big headline rendered in overlay/toast. */
  headline: string;
  /** Sub-line context. */
  reason: string;
  /** Optional fusion strip — machine agreement at fire time. */
  agreementScore?: number | null;
  /** Cross PTB probability (machine or estimate). */
  crossProb?: number | null;
  /** Model terminal win probability for the boom lane (0..100). */
  modelWinPct?: number | null;
  /** Per-share edge on the boom lane (+EV), if any. */
  edgePerShareUsd?: number | null;
  edgeQuality?: string | null;
  /** Implied mid on the side you would trim when EXIT_NOW (the fading lane). */
  oppositeMid?: number | null;
  /** Auto TP/SL from the same engine as the trade card — null if thin/−EV/settlement. */
  takeProfit?: number | null;
  stopLoss?: number | null;
  rrRatio?: number | null;
  /** True when TP/SL collapsed (e.g. under 60s to bell). */
  levelsCollapsed?: boolean;
  /**
   * Operator-verdict mirror of the trade-card verdict at fire time. Toast/overlay
   * listeners should prefer this for headline copy so alert language matches the
   * trade card exactly. Optional for back-compat with older dispatchers.
   */
  verdict?: {
    state: 'GO_LONG' | 'GO_SHORT' | 'EXIT_NOW' | 'HOLD' | 'STAND_DOWN';
    bigVerb: string;
    headline: string;
    reason: string;
    confidence: 'HIGH' | 'MED' | 'LOW';
  } | null;
};

/**
 * Dispatched when the PTB-cross probability crosses a high threshold (>= 70%) with
 * high model confidence. Distinct from BOOM because it isn't direction-aware on its
 * own — it just says "the line is about to flip" so listeners can warn the user.
 */
export const PTB_CROSS_IMMINENT_EVENT = 'ptb-cross-imminent-event';

export type PtbCrossImminentDetail = {
  slug: string;
  /** Probability of crossing PTB before round end, 0..1. */
  prob: number;
  /** Side spot is currently on (so the listener knows which side flips). */
  currentSide: 'above' | 'below' | 'at';
  /** Distance to PTB at the moment of dispatch ($). */
  distanceUsd: number;
  /** Implied round-end horizon (sec). */
  horizonSec: number;
  /** Pre-formatted labels for toast/banner copy. */
  upLabel: string;
  downLabel: string;
};
