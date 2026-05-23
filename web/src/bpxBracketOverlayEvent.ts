/** Dispatched by SignalsTradePanel so probability charts can draw SL/TP/REF in ¢ on the active outcome. */
export const BPX_BRACKET_OVERLAY_EVENT = 'bpx-bracket-overlay';

export type BpxBracketOverlayDetail = {
  tradeLane: 'up' | 'down';
  upToken: string;
  downToken: string;
  stopLossEnabled: boolean;
  takeProfitEnabled: boolean;
  slStopCents: string;
  tpTakeCents: string;
  refCents: string;
  /**
   * Exchange avg cost on `tradeLane` (0..1). Charts use this for TradingView-style +¢ / −¢ and % vs entry
   * on SL/TP/REF — separate from the PTB “ENTER LINE” (strategy trigger).
   */
  avgEntry01?: number | null;
};

/** Dispatched when the user drags SL/TP/REF on a chart; SignalsTradePanel updates text fields. */
export const BPX_BRACKET_DRAG_EVENT = 'bpx-bracket-drag';

export type BpxBracketDragDetail = {
  kind: 'sl' | 'tp' | 'ref';
  /** Price in cents (e.g. `"47"` or `"47.5"`), same convention as overlay inputs. */
  centsStr: string;
  tradeLane: 'up' | 'down';
  upToken: string;
  downToken: string;
};

/** Chart line tap when SL/TP overlay is muted — SignalsTradePanel arms automation. */
export const BPX_BRACKET_ARM_REQUEST_EVENT = 'bpx-bracket-arm-request';

export type BpxBracketArmRequestDetail = {
  kind: 'sl' | 'tp';
};
