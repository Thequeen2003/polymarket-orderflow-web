/**
 * Entry / TP / SL readout shared by TradeDirectiveCard and the Signals “Do this now” strip.
 */

import { formatCentsFrom01, formatCentsLabelFrom01 } from './displayCents';
import type { OperatorVerdict } from './operatorVerdict';
import type { TradeDirective } from './tradeDirective';
import type { TradeLevels } from './tradeLevels';

export type EntryProfitBrief =
  | {
      mode: 'full';
      token: string;
      whenCopy: string;
      entryCents: number;
      tpCents: number;
      slCents: number;
      profitCents: number;
      rr: number;
    }
  | {
      mode: 'mid_only';
      token: string;
      whenCopy: string;
      entryCents: number;
      note: string;
    }
  | {
      mode: 'wait';
      token: string;
      whenCopy: string;
      note: string;
    };

export function buildEntryProfitBrief(
  verdict: OperatorVerdict,
  directive: TradeDirective,
  levels: TradeLevels | null | undefined,
  upOutcomeLabel: string,
  downOutcomeLabel: string,
): EntryProfitBrief | null {
  if (verdict.isStandDown) return null;
  if (verdict.state !== 'GO_LONG' && verdict.state !== 'GO_SHORT') return null;
  if (!directive.lane) return null;
  const token = directive.lane === 'up' ? upOutcomeLabel : downOutcomeLabel;
  const whenCopy =
    directive.urgency === 'now'
      ? 'Now — time-sensitive; use a tight limit or join bid + one tick when the book is thin.'
      : directive.urgency === 'soon'
        ? 'Soon — next few minutes only; skip if touch spread is fat vs your edge.'
        : 'Patient — prefer bid joins / small pullbacks; do not chase a wide ask.';

  if (levels && !levels.collapsed) {
    return {
      mode: 'full',
      token,
      whenCopy,
      entryCents: levels.entry * 100,
      tpCents: levels.takeProfit * 100,
      slCents: levels.stopLoss * 100,
      profitCents: (levels.takeProfit - levels.entry) * 100,
      rr: levels.rrRatio,
    };
  }
  const mid = directive.laneMid;
  if (mid != null && Number.isFinite(mid)) {
    return {
      mode: 'mid_only',
      token,
      whenCopy,
      entryCents: mid * 100,
      note: 'Full TP/SL loads in the row below when the bracket syncs — treat this mid as your working anchor.',
    };
  }
  return {
    mode: 'wait',
    token,
    whenCopy,
    note: 'Waiting for a stable implied mid — do not size until TP/SL populates.',
  };
}

const MAX_LINE = 168;

/**
 * Settlement win probability on a binary outcome ≈ fair token price in ¢ before bell.
 * `pWin` and `laneMid` are both 0–1 (same units as Polymarket implied mids).
 */
export function formatTokenFairCentsLine(args: {
  pWin01: number;
  laneMid01?: number | null;
}): string {
  const p = Math.max(0, Math.min(1, args.pWin01));
  const fairC = formatCentsFrom01(p);
  const pct = Math.round(p * 100);
  const mid = args.laneMid01;
  if (mid == null || !Number.isFinite(mid)) {
    return `model fair ~${fairC}¢ (${pct}% win at bell)`;
  }
  const bookC = formatCentsFrom01(mid);
  const edgeC = Math.round((p - mid) * 100);
  const es = edgeC >= 0 ? '+' : '';
  return `fair ${fairC}¢ (${pct}%) · book ${bookC}¢ · ${es}${edgeC}¢/sh`;
}

function clip(s: string): string {
  const t = s.trim();
  if (t.length <= MAX_LINE) return t;
  return `${t.slice(0, MAX_LINE - 1)}…`;
}

function cents1From01(p: number): string {
  return formatCentsLabelFrom01(p);
}

/** `ENTER UP @ 62.0¢ · TP 74.0¢ · SL 55.0¢` — same ¢ as the card. */
export function formatEnterAtTpSl(args: {
  lane: 'up' | 'down';
  levels?: TradeLevels | null;
  mid01?: number | null;
}): string | null {
  const verb = args.lane === 'up' ? 'ENTER UP' : 'ENTER DOWN';
  if (args.levels && !args.levels.collapsed) {
    return `${verb} @ ${cents1From01(args.levels.entry)} · TP ${cents1From01(args.levels.takeProfit)} · SL ${cents1From01(args.levels.stopLoss)}`;
  }
  if (args.mid01 != null && Number.isFinite(args.mid01)) {
    return `${verb} @ ${cents1From01(args.mid01)} · TP/SL —`;
  }
  return null;
}

/**
 * One line for “Do this now” — straight ENTER @ TP/SL (card numbers).
 */
export function formatDeskEntryPrimary(
  verdict: OperatorVerdict,
  directive: TradeDirective | null | undefined,
  levels: TradeLevels | null | undefined,
  _upLabel: string,
  _downLabel: string,
): string {
  void _upLabel;
  void _downLabel;
  if (verdict.isStandDown) {
    return clip(verdict.bigVerb === "DON'T TRADE" ? "DON'T TRADE" : `${verdict.bigVerb} — wait`);
  }
  if (verdict.state === 'EXIT_NOW') {
    const lane = directive?.lane;
    if (lane === 'up' || lane === 'down') {
      const side = lane === 'up' ? 'UP' : 'DOWN';
      const at = formatEnterAtTpSl({ lane, levels, mid01: directive?.laneMid });
      if (at) return clip(`EXIT ${side} · ${at.replace(/^ENTER [A-Z]+ /, '')}`);
      return clip(`EXIT ${side}`);
    }
    return clip(verdict.bigVerb);
  }
  if (verdict.state === 'HOLD') {
    return clip(`${verdict.bigVerb}`);
  }
  if (!directive?.lane) {
    return clip(verdict.bigVerb);
  }

  const enterLine = formatEnterAtTpSl({
    lane: directive.lane,
    levels,
    mid01: directive.laneMid,
  });
  if (enterLine) return clip(enterLine);

  return clip(`${verdict.bigVerb === 'ENTER UP' || verdict.bigVerb === 'ENTER DOWN' ? verdict.bigVerb : `ENTER ${directive.lane === 'up' ? 'UP' : 'DOWN'}`} · prices loading`);
}

/** Second line: model fair ¢ vs book, then bracket R:R when levels exist. */
export function formatDeskEntryDetail(
  verdict: OperatorVerdict,
  directive: TradeDirective | null | undefined,
  levels: TradeLevels | null | undefined,
  upLabel: string,
  downLabel: string,
): string | null {
  if (!directive?.lane || verdict.isStandDown) {
    return verdict.reason?.trim() ? clip(verdict.reason) : null;
  }
  const brief = buildEntryProfitBrief(verdict, directive, levels, upLabel, downLabel);
  if (brief?.mode === 'full') {
    return clip(
      `Bracket +${Math.round(brief.profitCents)}¢/sh · R:R ${brief.rr.toFixed(2)} · limit near ${Math.round(brief.entryCents)}¢`,
    );
  }
  if (brief?.mode === 'mid_only') {
    return clip(`Working mid ${Math.round(brief.entryCents)}¢ — TP/SL row loading`);
  }
  if (brief?.mode === 'wait') {
    return clip(brief.note);
  }
  return verdict.reason?.trim() ? clip(verdict.reason) : null;
}
