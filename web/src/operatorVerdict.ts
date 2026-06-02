/**
 * Operator verdict — a single, dominant "what should I actually do RIGHT NOW"
 * answer that fuses the trade directive, TP/SL levels, stability, discrepancy,
 * cooldown, sizing multiplier, and (optionally) the No-Trade composite into ONE
 * 5-state output:
 *
 *   GO_LONG  → "ENTER UP" (concrete prices in headline)
 *   GO_SHORT → "ENTER DOWN"
 *   EXIT_NOW → "EXIT" / "FLIP"
 *   HOLD     → "STAY IN" / "STAY OUT"
 *   STAND_DOWN → "DON'T TRADE — <top blocker>"
 *
 * Why this exists: after layering EV / MTF / overextension / tape / discrepancy
 * etc., the card had ~10 chips and 4 stripes — operator reported it was hard to
 * tell when to enter or exit. The verdict band is the single source of truth.
 *
 * Optional **crossEngineLaneConflict** (Signals): when Spot vs PTB and Dual PTB
 * disagree on lane, fresh entries are forced to STAND_DOWN so the card matches Cross-check CONFLICT.
 *
 * Pure logic — no React, no DOM, fully unit-testable.
 */
import type { TradeDirective } from './tradeDirective';
import type { TradeLevels } from './tradeLevels';
import type { DirectiveStability } from './directiveStability';
import type { DirectiveDiscrepancy } from './directiveDiscrepancyGuard';
import type { ReEntryGuardCheck } from './reEntryGuard';
import type { SizingMultiplier } from './directiveSizingMultiplier';
import type { NoTradeScore } from './noTradeScore';

export type VerdictState = 'GO_LONG' | 'GO_SHORT' | 'EXIT_NOW' | 'HOLD' | 'STAND_DOWN';

export type VerdictColor = 'green' | 'red' | 'blue' | 'amber' | 'gray';

export type VerdictConfidence = 'HIGH' | 'MED' | 'LOW';

export type OperatorVerdict = {
  state: VerdictState;
  color: VerdictColor;
  /** Big bold verb (≤14 chars) — answers "what do I do?". e.g. "ENTER UP", "EXIT NOW", "DON'T TRADE". */
  bigVerb: string;
  /** Concrete sentence with prices when applicable. e.g. "@ 0.62 — TP 0.74 / SL 0.55 (R:R 1.6)". */
  headline: string;
  /** One short reason explaining *why* the verdict is what it is. */
  reason: string;
  confidence: VerdictConfidence;
  /** When verdict was forced down by guards, list the top blockers (UI tooltip / details). */
  blockers: string[];
  /** When STAND_DOWN, name of the dominant blocker (e.g. "WHIPSAW", "COOLDOWN", "DISCREPANCY"). */
  primaryBlocker: string | null;
  /** True when the verdict explicitly recommends NOT trading right now. */
  isStandDown: boolean;
};

export type OperatorVerdictInput = {
  directive: TradeDirective | null;
  levels?: TradeLevels | null;
  stability?: DirectiveStability | null;
  discrepancy?: DirectiveDiscrepancy | null;
  reEntry?: ReEntryGuardCheck | null;
  sizingMultiplier?: SizingMultiplier | null;
  /** Optional No-Trade composite. When tier === 'RED' and score is very high, forces STAND_DOWN regardless of directive. */
  noTradeScore?: NoTradeScore | null;
  /**
   * When true (Signals tab: Dual vs Spot disagree on lane), blocks INITIATE/ADD/FLIP GO
   * so the Answer card matches Cross-check CONFLICT.
   */
  crossEngineLaneConflict?: boolean | null;
  /**
   * When `crossEngineLaneConflict` is true, pass both engine lanes so STAND_DOWN copy explains
   * why ACT NOW is off for **both** sides (operators often read that as “DOWN is broken”).
   */
  crossCheckSpotLane?: 'up' | 'down' | null;
  crossCheckDualLane?: 'up' | 'down' | null;
};

/** Build a single dominant operator verdict from the directive + guards. */
export function buildOperatorVerdict(input: OperatorVerdictInput): OperatorVerdict {
  const blockers: string[] = [];

  // ─── Hard blockers (force STAND_DOWN) ───────────────────────────────────
  // Only block on *extreme* friction. The math (edge, pWin, book prices) is the
  // primary authority. Guards exist to prevent catastrophic whipsaw / spam, not
  // to second-guess valid +EV trades.
  if (input.noTradeScore && input.noTradeScore.tier === 'RED' && input.noTradeScore.score >= 98) {
    blockers.push(`No-Trade ${input.noTradeScore.score}/100`);
  }
  // Cross-check conflict: only block when confidence is LOW AND the directive has no edge.
  if (
    input.crossEngineLaneConflict &&
    input.directive?.action === 'INITIATE' &&
    input.directive.confidence === 'LOW' &&
    (input.directive.edgePerShareUsd == null || input.directive.edgePerShareUsd < 0.03)
  ) {
    blockers.push('Spot vs Dual lane mismatch');
  }
  // Discrepancy: only block on extreme score. Prior threshold of 92 was too strict.
  if (input.discrepancy?.shouldBlock && input.discrepancy.score >= 96) {
    blockers.push('sensors disagree');
  }
  // Whipsaw: only block on extreme flip rates (was 12, keeping it).
  if (
    input.stability &&
    input.stability.tier === 'whipsaw' &&
    input.stability.flipsLastMin >= 12 &&
    input.directive?.action === 'INITIATE'
  ) {
    blockers.push(`whipsaw ${input.stability.flipsLastMin}/min`);
  }
  if (
    input.reEntry?.onCooldown &&
    isActionable(input.directive?.action) &&
    input.reEntry.lane != null &&
    input.directive?.lane === input.reEntry.lane
  ) {
    blockers.push(`cool-down ${Math.ceil(input.reEntry.msRemaining / 1000)}s`);
  }
  if (input.directive?.action === 'STAND_DOWN') {
    blockers.push(input.directive.reason || 'WAIT');
  }

  // --- No directive at all -------------------------------------------------
  if (!input.directive) {
    return standDown('No signal yet', 'Waiting for spot + PTB sync.', blockers, null);
  }

  const d = input.directive;
  const primaryBlocker = blockers[0] ?? null;

  // --- Forced STAND_DOWN ---------------------------------------------------
  if (blockers.length > 0) {
    const dominantBlocker = primaryBlocker ?? 'guards active';
    const laneU = (l: 'up' | 'down') => l.toUpperCase();
    const mismatchDetail =
      input.crossEngineLaneConflict &&
      input.crossCheckSpotLane != null &&
      input.crossCheckDualLane != null &&
      input.crossCheckSpotLane !== input.crossCheckDualLane
        ? ` Spot strip → ${laneU(input.crossCheckSpotLane)}, Dual implied → ${laneU(input.crossCheckDualLane)} — fresh ENTER / ACT NOW is off for both until Cross-check clears.`
        : '';

    let headline = `Wait — ${dominantBlocker}.`;
    let reason = blockers.length > 1 ? `${blockers.length} blockers: ${blockers.join(', ')}.` : d.reason;

    if (primaryBlocker === 'Spot vs Dual lane mismatch' && mismatchDetail) {
      headline = `Wait — Spot/Dual disagree.${mismatchDetail}`;
      reason =
        blockers.length > 1
          ? `${blockers.length} blockers: ${blockers.join(', ')}.${mismatchDetail}`
          : `${d.reason}${mismatchDetail}`;
    } else if (mismatchDetail && blockers.includes('Spot vs Dual lane mismatch')) {
      reason = `${reason}${mismatchDetail}`;
    }

    return {
      state: 'STAND_DOWN',
      color: 'gray',
      bigVerb: "DON'T TRADE",
      headline,
      reason,
      confidence: 'LOW',
      blockers,
      primaryBlocker,
      isStandDown: true,
    };
  }

  // --- EXIT family ---------------------------------------------------------
  if (d.action === 'EXIT') {
    return {
      state: 'EXIT_NOW',
      color: 'red',
      bigVerb: laneVerb('EXIT', d.lane),
      headline: laneExitHeadline(d, input.levels ?? null),
      reason: d.reason,
      confidence: d.confidence,
      blockers,
      primaryBlocker: null,
      isStandDown: false,
    };
  }

  if (d.action === 'FLIP') {
    return {
      state: 'EXIT_NOW',
      color: 'red',
      bigVerb: laneVerb('FLIP →', d.lane),
      headline: flipHeadline(d, input.levels ?? null),
      reason: d.reason,
      confidence: d.confidence,
      blockers,
      primaryBlocker: null,
      isStandDown: false,
    };
  }

  // --- TRIM (treat as soft exit) -------------------------------------------
  if (d.action === 'TRIM') {
    return {
      state: 'EXIT_NOW',
      color: 'amber',
      bigVerb: 'TRIM',
      headline: trimHeadline(d, input.levels ?? null),
      reason: d.reason,
      confidence: d.confidence,
      blockers,
      primaryBlocker: null,
      isStandDown: false,
    };
  }

  // --- HOLD ----------------------------------------------------------------
  if (d.action === 'HOLD') {
    return {
      state: 'HOLD',
      color: 'blue',
      bigVerb: d.lane ? `HOLD ${d.lane.toUpperCase()}` : 'STAY OUT',
      headline: holdHeadline(d),
      reason: d.reason,
      confidence: d.confidence,
      blockers,
      primaryBlocker: null,
      isStandDown: false,
    };
  }

  // --- INITIATE / ADD ------------------------------------------------------
  if (d.action === 'INITIATE' || d.action === 'ADD') {
    const lane = d.lane;
    if (!lane) {
      // Defensive: action says enter but lane is missing — treat as stand down.
      return standDown('Signal incomplete', 'Lane unresolved.', blockers, null);
    }
    return {
      state: lane === 'up' ? 'GO_LONG' : 'GO_SHORT',
      color: 'green',
      bigVerb: laneVerb(d.action === 'ADD' ? 'ADD' : 'ENTER', lane),
      headline: enterHeadline(d, input.levels ?? null),
      reason: enterReason(d, input.sizingMultiplier ?? null),
      confidence: enterConfidence(d, input.stability ?? null, input.sizingMultiplier ?? null),
      blockers,
      primaryBlocker: null,
      isStandDown: false,
    };
  }

  // Fallback (should be unreachable for known DirectiveAction values).
  return standDown('Unknown trade line', d.reason || 'Unrecognized action.', blockers, null);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isActionable(action: TradeDirective['action'] | undefined): boolean {
  return action === 'INITIATE' || action === 'ADD' || action === 'FLIP';
}

function laneVerb(prefix: string, lane: 'up' | 'down' | null): string {
  if (!lane) return prefix.trim();
  return `${prefix} ${lane.toUpperCase()}`.trim();
}

function fmtPct01(p: number | null | undefined): string | null {
  if (p == null || !Number.isFinite(p)) return null;
  return p.toFixed(2);
}

function enterHeadline(d: TradeDirective, levels: TradeLevels | null): string {
  const entry = fmtPct01(d.laneMid);
  // `collapsed` is only set in the final seconds before the bell; missing `levels`
  // is usually book/model sync — do not label that as "settlement window".
  if (levels?.collapsed) {
    if (entry) return `Buy near ${entry} — settlement window, no preset TP/SL.`;
    return d.headline;
  }
  if (!levels) {
    if (entry) return `Buy near ${entry} — TP/SL row still loading.`;
    return d.headline;
  }
  const tp = levels.takeProfit.toFixed(2);
  const sl = levels.stopLoss.toFixed(2);
  const rr = levels.rrRatio.toFixed(2);
  const at = entry ?? levels.entry.toFixed(2);
  return `@ ${at} — TP ${tp} / SL ${sl} · R:R ${rr}`;
}

function laneExitHeadline(d: TradeDirective, levels: TradeLevels | null): string {
  const at = fmtPct01(d.laneMid);
  if (at) return `Close ${d.lane ?? ''} near ${at} — preserve profit.`.trim();
  if (levels && !levels.collapsed) return `Close near ${levels.entry.toFixed(2)}.`;
  return d.headline;
}

function flipHeadline(d: TradeDirective, levels: TradeLevels | null): string {
  const closeName = d.flipHeldOutcomeLabel ?? (d.lane === 'up' ? 'DOWN' : 'UP');
  const enterName = d.laneOutcomeLabel ?? (d.lane === 'up' ? 'UP' : d.lane === 'down' ? 'DOWN' : 'TARGET');
  const target = fmtPct01(d.laneMid);
  if (target) return `1) Close/sell ${closeName} first. 2) Then buy ${enterName} near ${target}.`;
  if (levels && !levels.collapsed) return `1) Close/sell ${closeName} first. 2) Then switch near ${levels.entry.toFixed(2)}.`;
  return d.headline;
}

function trimHeadline(d: TradeDirective, levels: TradeLevels | null): string {
  const at = fmtPct01(d.laneMid);
  if (at) return `Take partial off near ${at}.`;
  if (levels && !levels.collapsed) return `Take partial off near ${levels.entry.toFixed(2)}.`;
  return d.headline;
}

function holdHeadline(d: TradeDirective): string {
  const at = fmtPct01(d.laneMid);
  if (at && d.lane) return `Stay ${d.lane.toUpperCase()} — mid ${at}, no change.`;
  return d.reason;
}

function enterReason(d: TradeDirective, mult: SizingMultiplier | null): string {
  // Combine top evidence bullet with sizing context if reduced.
  const top = d.evidence[0] ?? d.reason;
  if (mult && mult.combined < 0.7 && mult.notes.length > 0) {
    return `${top} (size adj ×${mult.combined.toFixed(2)} — ${mult.notes[0]})`;
  }
  return top;
}

function enterConfidence(
  d: TradeDirective,
  stability: DirectiveStability | null,
  mult: SizingMultiplier | null,
): VerdictConfidence {
  // Start from directive confidence then downgrade for friction.
  let conf: VerdictConfidence = d.confidence;
  if (stability && stability.tier === 'forming') conf = downgrade(conf);
  if (mult && mult.combined < 0.6) conf = downgrade(conf);
  return conf;
}

function downgrade(c: VerdictConfidence): VerdictConfidence {
  if (c === 'HIGH') return 'MED';
  return 'LOW';
}

function standDown(
  verb: string,
  headline: string,
  blockers: string[],
  primary: string | null,
): OperatorVerdict {
  return {
    state: 'STAND_DOWN',
    color: 'gray',
    bigVerb: verb,
    headline,
    reason: headline,
    confidence: 'LOW',
    blockers,
    primaryBlocker: primary,
    isStandDown: true,
  };
}
