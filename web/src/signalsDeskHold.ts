/** Clear Signals desk “I hold · UP/DOWN” when the held outcome position is flat. */

export const BPX_SIGNALS_CLEAR_HOLD_EVENT = 'bpx-signals-clear-hold';

/** Operator says they did not buy — zero UI position + refresh wallet for this market. */
export const BPX_RESET_PHANTOM_POSITION_EVENT = 'bpx-reset-phantom-position';

export type ResetPhantomPositionDetail = {
  upToken?: string;
  downToken?: string;
  slug?: string;
};

export type SignalsClearHoldDetail = {
  lane: 'up' | 'down';
};

export function dispatchResetPhantomPosition(detail: ResetPhantomPositionDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(BPX_RESET_PHANTOM_POSITION_EVENT, { detail }));
}

export function dispatchSignalsClearHold(detail: SignalsClearHoldDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(BPX_SIGNALS_CLEAR_HOLD_EVENT, { detail }));
}

/** True when outcome shares are effectively zero after a sell. */
export function isOutcomePositionFlat(shares: number | null | undefined): boolean {
  if (shares == null || !Number.isFinite(shares)) return false;
  return shares <= 1e-4;
}

/**
 * Push the trade card lane to the trade panel only when the card lane actually changes.
 * Do not re-sync on every render when the operator picked the other outcome on the panel.
 */
/** Debounce card→panel lane sync so directive whipsaw does not flip the trade UI. */
export const TRADE_PANEL_LANE_SYNC_DEBOUNCE_MS = 2_500;

export function shouldSyncTradePanelToMasterLane(args: {
  masterLane: 'up' | 'down' | null;
  previousMasterLane: 'up' | 'down' | null;
  manualPositionLane: 'up' | 'down' | null;
  masterReady: boolean;
  /** When the trade card is flipping lanes rapidly, do not push to the panel. */
  whipsaw?: boolean;
}): boolean {
  const { masterLane, previousMasterLane, manualPositionLane, masterReady, whipsaw } = args;
  if (!masterReady || masterLane == null) return false;
  if (whipsaw === true) return false;
  if (manualPositionLane != null && manualPositionLane !== masterLane) return false;
  if (previousMasterLane === masterLane) return false;
  return true;
}
