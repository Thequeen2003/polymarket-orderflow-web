/**
 * One actionable TP/SL call for a held position — desk Targets TP vs avg entry,
 * not “display mid is falling”.
 */

import { deskTpBelowEntry } from './nowPriceDeskScalp';

export type BracketCallAction = 'sell_now' | 'take_profit' | 'watch_sl' | 'hold';

export type BracketCallSeverity = 'danger' | 'warn' | 'profit' | 'ok';

export type PositionBracketCall = {
  action: BracketCallAction;
  severity: BracketCallSeverity;
  headline: string;
  detail: string;
  reason:
    | 'sl_crossed'
    | 'desk_tp_below_entry'
    | 'tp_hit'
    | 'sl_near'
    | 'on_track';
  entryCents: number;
  armedTpCents: number | null;
  armedSlCents: number | null;
  liveDeskTpCents: number | null;
  bidCents: number | null;
};

function fmtCents(p01: number): string {
  return `${(p01 * 100).toFixed(1)}¢`;
}

function valid01(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v) && v > 0 && v < 1;
}

/** Single TP/SL exit call — priority: TP hit → SL hit → desk TP under entry → SL near → hold. */
export function computePositionBracketCall(input: {
  entry01: number | null | undefined;
  armedTp01?: number | null;
  armedSl01?: number | null;
  /** Live desk Targets TP from current book (quote-assist row). */
  liveDeskTp01?: number | null;
  /** Best bid — used for SL/TP cross, not chart/display mid. */
  bid01?: number | null;
  /** Cents buffer before SL counts as “near”. */
  slNearCents?: number;
}): PositionBracketCall | null {
  const entry01 = input.entry01;
  if (!valid01(entry01)) return null;

  const armedTp01 = valid01(input.armedTp01) ? input.armedTp01 : null;
  const armedSl01 = valid01(input.armedSl01) ? input.armedSl01 : null;
  const liveDeskTp01 = valid01(input.liveDeskTp01) ? input.liveDeskTp01 : null;
  const bid01 = valid01(input.bid01) ? input.bid01 : null;
  const slNear = Math.max(0.5, input.slNearCents ?? 1.5) / 100;

  const entryCents = entry01 * 100;
  const metrics = {
    entryCents,
    armedTpCents: armedTp01 != null ? armedTp01 * 100 : null,
    armedSlCents: armedSl01 != null ? armedSl01 * 100 : null,
    liveDeskTpCents: liveDeskTp01 != null ? liveDeskTp01 * 100 : null,
    bidCents: bid01 != null ? bid01 * 100 : null,
  };

  const bullishTp = armedTp01 == null || armedTp01 >= entry01 - 1e-9;

  if (armedTp01 != null && bid01 != null) {
    const tpHit = bullishTp ? bid01 >= armedTp01 - 1e-9 : bid01 <= armedTp01 + 1e-9;
    if (tpHit) {
      return {
        action: 'take_profit',
        severity: 'profit',
        reason: 'tp_hit',
        headline: `Take profit — bid at ${fmtCents(bid01)} reached TP ${fmtCents(armedTp01)}.`,
        detail: `Entry ${fmtCents(entry01)} · sell into the touch; don't wait for a perfect print.`,
        ...metrics,
      };
    }
  }

  if (armedSl01 != null && bid01 != null) {
    const slHit = bullishTp ? bid01 <= armedSl01 + 1e-9 : bid01 >= armedSl01 - 1e-9;
    if (slHit) {
      return {
        action: 'sell_now',
        severity: 'danger',
        reason: 'sl_crossed',
        headline: `Sell now — bid ${fmtCents(bid01)} hit stop ${fmtCents(armedSl01)}.`,
        detail: `Avg entry ${fmtCents(entry01)} · stop is your hard exit; take the bid.`,
        ...metrics,
      };
    }
    const slNearHit = bullishTp
      ? bid01 <= armedSl01 + slNear && bid01 > armedSl01 + 1e-9
      : bid01 >= armedSl01 - slNear && bid01 < armedSl01 - 1e-9;
    if (slNearHit) {
      return {
        action: 'watch_sl',
        severity: 'warn',
        reason: 'sl_near',
        headline: `Watch stop — bid ${fmtCents(bid01)} is within ${(slNear * 100).toFixed(1)}¢ of SL ${fmtCents(armedSl01)}.`,
        detail: `Entry ${fmtCents(entry01)} · tighten or sell before the stop tags.`,
        ...metrics,
      };
    }
  }

  if (liveDeskTp01 != null && deskTpBelowEntry(entry01, liveDeskTp01)) {
    const armedTpNote =
      armedTp01 != null && armedTp01 > liveDeskTp01 + 1e-9
        ? ` Your armed TP ${fmtCents(armedTp01)} won't pay at a gain if desk targets stay here.`
        : '';
    return {
      action: 'sell_now',
      severity: 'danger',
      reason: 'desk_tp_below_entry',
      headline: `Sell now — desk TP ${fmtCents(liveDeskTp01)} fell below entry ${fmtCents(entry01)}.`,
      detail: `Live Targets collapsed under your avg entry — waiting for the old TP is hope, not edge.${armedTpNote}`,
      ...metrics,
    };
  }

  const tpLine =
    armedTp01 != null
      ? `Armed TP ${fmtCents(armedTp01)}`
      : liveDeskTp01 != null
        ? `Desk TP ${fmtCents(liveDeskTp01)}`
        : 'TP not set';
  const slLine = armedSl01 != null ? ` · SL ${fmtCents(armedSl01)}` : '';
  const bidLine = bid01 != null ? ` · bid ${fmtCents(bid01)}` : '';

  return {
    action: 'hold',
    severity: 'ok',
    reason: 'on_track',
    headline: `Hold — ${tpLine} still above entry ${fmtCents(entry01)}.`,
    detail: `${tpLine}${slLine}${bidLine} · invalidation is stop or desk TP under entry, not every dip in display mid.`,
    ...metrics,
  };
}
