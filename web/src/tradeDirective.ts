/**
 * Top-level trade card line — translates the fused machine readout (focus lane,
 * agreement, cross prob, urgency, acceleration, regime) plus the user's current
 * position into a single, actionable verb: INITIATE / ADD / HOLD / TRIM / EXIT /
 * FLIP / STAND_DOWN.
 *
 * Pure function — easy to test, no React. The chart wires this in a useMemo and
 * renders it via <TradeDirectiveCard />.
 */

import { orderFlowConflictsLane, type SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { SwitchForecast } from './sectionalMomentum';

export type DirectiveAction =
  | 'INITIATE'
  | 'ADD'
  | 'HOLD'
  | 'TRIM'
  | 'EXIT'
  | 'FLIP'
  | 'STAND_DOWN';

export type DirectiveUrgency = 'now' | 'soon' | 'patient';

export type TradeDirective = {
  action: DirectiveAction;
  /** Lane the directive is *about* — e.g. "INITIATE up" / "FLIP to down" / null for STAND_DOWN. */
  lane: 'up' | 'down' | null;
  urgency: DirectiveUrgency;
  /** Suggested size as a fraction 0..1 of the user's available bank for this round. */
  recommendedSize: number;
  /** ≤6 word headline rendered in big bold type. */
  headline: string;
  /** One-sentence reason (the "why"). */
  reason: string;
  /** Up to 4 short bullet points supporting the call. */
  evidence: string[];
  /** Confidence band derived from agreement + cross prob + dwell maturity. */
  confidence: 'HIGH' | 'MED' | 'LOW';
  /** True when this is a defensive call (EXIT / TRIM / STAND_DOWN). */
  defensive: boolean;
  /** $/share edge for the suggested lane (positive = +EV) — null when not computable. */
  edgePerShareUsd: number | null;
  /** Mid the edge is computed against (0..1). */
  laneMid: number | null;
  /** Model probability the suggested lane wins at settlement. */
  laneWinProb: number | null;
  /**
   * Human-readable outcome name for `lane` (e.g. market slug label). Used so TP/SL
   * is clearly scoped to **this token's** price, not spot vs PTB or a generic "UP".
   */
  laneOutcomeLabel?: string | null;
  /**
   * When `action === 'FLIP'`, the held outcome to exit **before** adding `lane`
   * (two-leg execution — avoids “ACT NOW” on the new buy while the old leg is still open).
   */
  flipHeldOutcomeLabel?: string | null;
};

export type TradeDirectiveInput = {
  machine: SpotPtbMachineReadout | null;
  forecast: SwitchForecast | null;
  /**
   * Lane the user is currently long. `null` = flat (will produce INITIATE / STAND_DOWN).
   * `'up'`/`'down'` toggles HOLD / FLIP / EXIT branches.
   */
  currentPositionLane: 'up' | 'down' | null;
  /** Labels for headline copy. */
  upLabel?: string;
  downLabel?: string;
};

const STAND_DOWN: TradeDirective = {
  action: 'STAND_DOWN',
  lane: null,
  urgency: 'patient',
  recommendedSize: 0,
  headline: 'WAIT',
  reason: 'No clean edge — sensors split or signal too weak to act on.',
  evidence: [],
  confidence: 'LOW',
  defensive: true,
  edgePerShareUsd: null,
  laneMid: null,
  laneWinProb: null,
  laneOutcomeLabel: null,
};

function cap(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Map agreement + acceleration + cross-prob + MTF + overextension into a 0..1 size. */
function sizeFor(args: {
  agreement: number;
  cross: number | null;
  regime: SpotPtbMachineReadout['regime'];
  urgency: SpotPtbMachineReadout['urgency'];
  defensive: boolean;
  acceleration: SpotPtbMachineReadout['acceleration'];
  mtf?: SpotPtbMachineReadout['mtf'];
  overextension?: SpotPtbMachineReadout['overextension'];
  /** When set, weight size by edge quality (HIGH = full, NEGATIVE = 0). */
  edgeUsd?: number | null;
  focusLane?: 'up' | 'down' | null;
}): number {
  const { agreement, cross, regime, urgency, defensive, acceleration, mtf, overextension, edgeUsd, focusLane } = args;
  if (defensive) return 0;
  if (urgency === 'settlement') return 0;
  // Base from agreement (0 below 40 → 0..1 above).
  let s = cap((agreement - 40) / 50, 0, 1);
  if (cross != null) {
    if (cross >= 0.25 && cross <= 0.6) s *= 0.7; // coin-flip-ish — size down
  }
  if (regime === 'chop') s *= 0.5;
  else if (regime === 'grind') s *= 0.85;
  if (urgency === 'critical') s = Math.min(1, s * 1.05);
  if (acceleration && (acceleration.state === 'accel-up' || acceleration.state === 'accel-down')) {
    s = Math.min(1, s + 0.1);
  } else if (acceleration?.state === 'reversing') {
    s *= 0.6;
  }
  // MTF stack: full agreement = bigger size; conflict = smaller.
  if (mtf && mtf.dominantLane && focusLane && mtf.dominantLane === focusLane) {
    if (mtf.fullAgreement) s = Math.min(1, s + 0.1);
    else if (mtf.alignedCount >= 2 && !mtf.hasConflict) s = Math.min(1, s + 0.05);
  } else if (mtf && mtf.hasConflict) {
    s *= 0.75;
  }
  // Overextension: penalize chasing the move.
  if (overextension && overextension.state === 'overextended' && focusLane && overextension.direction === focusLane) {
    s *= 0.55;
  } else if (overextension && overextension.state === 'stretched' && focusLane && overextension.direction === focusLane) {
    s *= 0.8;
  }
  // Edge quality: scale by absolute edge — no edge = no size.
  if (edgeUsd != null) {
    if (edgeUsd <= 0) return 0;
    if (edgeUsd < 0.015) s *= 0.4; // THIN edge: small probe size
    else if (edgeUsd < 0.05) s *= 0.7; // LOW
    else if (edgeUsd < 0.12) s *= 1.0; // MED
    else s = Math.min(1, s + 0.1); // HIGH
  }
  return cap(s, 0, 1);
}

function laneLabel(lane: 'up' | 'down' | null, upLabel?: string, downLabel?: string): string {
  if (!lane) return '—';
  return lane === 'up' ? (upLabel ?? 'UP').toUpperCase() : (downLabel ?? 'DOWN').toUpperCase();
}

function confidenceFrom(
  agreement: number,
  crossConfHigh: boolean,
  dwellMature: boolean,
  probVsSpot?: SpotPtbMachineReadout['probVsSpot'],
): TradeDirective['confidence'] {
  if (agreement >= 70 && (dwellMature || crossConfHigh)) return 'HIGH';
  if (agreement >= 58 && probVsSpot === 'aligned') return 'MED';
  if (agreement >= 50) return 'MED';
  return 'LOW';
}

/**
 * Convert the fused machine readout + position into a single recommended action.
 * Returns STAND_DOWN when inputs aren’t actionable (missing readout, settlement
 * window with no position, low agreement in chop, etc.).
 */
export function buildTradeDirective(input: TradeDirectiveInput): TradeDirective {
  const { machine, forecast, currentPositionLane, upLabel, downLabel } = input;
  if (!machine || !machine.focusLane) {
    return {
      ...STAND_DOWN,
      reason: machine
        ? 'Sensors split — no single lane has consensus right now.'
        : 'Waiting for fused machine readout (need spot ticks + PTB + book).',
    };
  }

  const lane = machine.focusLane;
  const agreement = machine.agreementScore;
  const cross = machine.crossProb;
  const regime = machine.regime;
  const urgency = machine.urgency;
  const acceleration = machine.acceleration;
  const probVsSpot = machine.probVsSpot;
  const mtf = machine.mtf;
  const overext = machine.overextension;
  const edges = machine.edges;
  const fStatus = forecast?.status ?? 'WAIT';
  const fConf = forecast?.confidence ?? 'LOW';
  const dwellMature = fConf !== 'LOW' && fStatus !== 'WAIT';
  const crossConfHigh = machine.crossEstimate?.confidence === 'high';
  const conf = (a: number) => confidenceFrom(a, crossConfHigh, dwellMature, probVsSpot);
  const evidence: string[] = [];

  /** Pull lane-specific edge details from the lane edges blob. */
  const laneEdge = (l: 'up' | 'down' | null) =>
    l == null ? null : l === 'up' ? edges?.up ?? null : edges?.down ?? null;

  /** Auto-fill the edge/mid/winProb fields based on a directive's lane. */
  const finalize = (
    d: Omit<TradeDirective, 'edgePerShareUsd' | 'laneMid' | 'laneWinProb' | 'laneOutcomeLabel'>,
  ): TradeDirective => {
    const e = laneEdge(d.lane);
    const laneOutcomeLabel =
      d.lane === 'up' ? (upLabel ?? 'UP') : d.lane === 'down' ? (downLabel ?? 'DOWN') : null;
    const flipHeldOutcomeLabel =
      d.action === 'FLIP' && currentPositionLane != null ? laneLabel(currentPositionLane, upLabel, downLabel) : null;
    return {
      ...d,
      laneOutcomeLabel,
      flipHeldOutcomeLabel,
      edgePerShareUsd: e?.edgePerShareUsd ?? null,
      laneMid: e?.mid ?? null,
      laneWinProb: e?.pWin ?? null,
    };
  };

  // 1) Settlement window — no entries / flips, only EXIT branch keeps firing.
  if (urgency === 'settlement') {
    if (currentPositionLane && currentPositionLane !== lane) {
      evidence.push('<60s left — no time for a flip to prove out');
      if (cross != null && cross >= 0.58 && agreement >= 60) {
        return finalize({
          action: 'EXIT',
          lane: currentPositionLane,
          urgency: 'now',
          recommendedSize: 0,
          headline: `EXIT ${laneLabel(currentPositionLane, upLabel, downLabel)}`,
          reason: `Settlement window with cross prob ${Math.round(cross * 100)}% — line likely flips against us before the bell.`,
          evidence: ['Urgency: SETTLEMENT', `Cross prob ${Math.round(cross * 100)}%`, `Agreement ${agreement}% on ${lane}`],
          confidence: 'HIGH',
          defensive: true,
        });
      }
      return finalize({
        action: 'HOLD',
        lane: currentPositionLane,
        urgency: 'now',
        recommendedSize: 0,
        headline: `HOLD ${laneLabel(currentPositionLane, upLabel, downLabel)} — RIDE OUT`,
        reason: 'Settlement: no time to flip cleanly; ride your existing exposure.',
        evidence,
        confidence: 'MED',
        defensive: true,
      });
    }
    if (currentPositionLane === lane) {
      return finalize({
        action: 'HOLD',
        lane,
        urgency: 'now',
        recommendedSize: 0,
        headline: `HOLD ${laneLabel(lane, upLabel, downLabel)}`,
        reason: 'Settlement window — protect what you have, no new size.',
        evidence: ['Urgency: SETTLEMENT', `Agreement ${agreement}% aligned`],
        confidence: 'MED',
        defensive: true,
      });
    }
    return {
      ...STAND_DOWN,
      urgency: 'now',
      headline: 'WAIT — SETTLEMENT',
      reason: 'Round ending — too late to enter cleanly.',
    };
  }

  // 2) In-position branch — HOLD / ADD / TRIM / EXIT / FLIP based on alignment.
  if (currentPositionLane != null) {
    // Sectional EXIT on *your* lane — only act when the strip is not a LOW-confidence flicker.
    if (
      fStatus === 'EXIT' &&
      forecast?.lane === currentPositionLane &&
      forecast.confidence !== 'LOW'
    ) {
      evidence.push(`Forecast: EXIT ${laneLabel(currentPositionLane, upLabel, downLabel)}`);
      if (cross != null) evidence.push(`Cross prob ${Math.round(cross * 100)}%`);
      evidence.push(`Agreement ${agreement}% on ${laneLabel(lane, upLabel, downLabel)}`);
      return finalize({
        action: 'EXIT',
        lane: currentPositionLane,
        urgency: agreement >= 70 ? 'now' : 'soon',
        recommendedSize: 0,
        headline: `EXIT ${laneLabel(currentPositionLane, upLabel, downLabel)}`,
        reason: forecast?.reason ?? 'Sectional engine flagged exit on this lane.',
        evidence,
        confidence: conf(agreement),
        defensive: true,
      });
    }

    // Position aligns with consensus — HOLD or ADD.
    if (currentPositionLane === lane) {
      const accelMatch =
        (acceleration?.state === 'accel-up' && lane === 'up') ||
        (acceleration?.state === 'accel-down' && lane === 'down');
      const reversing = acceleration?.state === 'reversing';
      const trimming = reversing || (probVsSpot === 'conflict' && agreement < 65);
      if (trimming) {
        evidence.push(reversing ? 'Acceleration: reversing' : `Conflict: implied vs spot mismatch`);
        evidence.push(`Agreement ${agreement}% on ${laneLabel(lane, upLabel, downLabel)}`);
        if (cross != null) evidence.push(`Cross prob ${Math.round(cross * 100)}%`);
        return finalize({
          action: 'TRIM',
          lane,
          urgency: agreement >= 60 ? 'soon' : 'patient',
          recommendedSize: 0,
          headline: `TRIM ${laneLabel(lane, upLabel, downLabel)}`,
          reason: reversing
            ? 'Late slope flipped against the prior tape — reduce exposure before confirmation.'
            : 'Implied probability and spot disagree — book gains, wait for re-alignment.',
          evidence,
          confidence: 'MED',
          defensive: true,
        });
      }
      const eAlign = laneEdge(lane);
      const edgeAlignUsd = eAlign?.edgePerShareUsd ?? null;
      const wantAdd =
        agreement >= 75 &&
        accelMatch &&
        (cross == null || cross <= 0.55) &&
        fStatus !== 'WAIT' &&
        (edgeAlignUsd == null || edgeAlignUsd >= 0.03);
      if (wantAdd) {
        const size = sizeFor({
          agreement,
          cross,
          regime,
          urgency,
          defensive: false,
          acceleration,
          mtf,
          overextension: overext,
          edgeUsd: edgeAlignUsd,
          focusLane: lane,
        });
        evidence.push(`Agreement ${agreement}% on ${laneLabel(lane, upLabel, downLabel)}`);
        if (acceleration) evidence.push(acceleration.summary);
        if (cross != null) evidence.push(`Cross prob ${Math.round(cross * 100)}%`);
        if (eAlign) evidence.push(`Edge ${eAlign.edgePerShareUsd >= 0 ? '+' : ''}${eAlign.edgePerShareUsd.toFixed(2)}/share at mid ${eAlign.mid.toFixed(2)}`);
        if (regime !== 'grind') evidence.push(`Regime: ${regime.toUpperCase()}`);
        return finalize({
          action: 'ADD',
          lane,
          urgency: urgency === 'critical' ? 'now' : 'soon',
          recommendedSize: Math.max(0.15, size * 0.5),
          headline: `ADD ${laneLabel(lane, upLabel, downLabel)}`,
          reason: 'Already aligned with consensus and momentum is accelerating — press the edge.',
          evidence,
          confidence: conf(agreement),
          defensive: false,
        });
      }
      // Plain HOLD.
      evidence.push(`Agreement ${agreement}% on ${laneLabel(lane, upLabel, downLabel)}`);
      if (acceleration) evidence.push(acceleration.summary);
      if (cross != null) evidence.push(`Cross prob ${Math.round(cross * 100)}%`);
      if (eAlign) evidence.push(`Edge ${eAlign.edgePerShareUsd >= 0 ? '+' : ''}${eAlign.edgePerShareUsd.toFixed(2)}/share at mid ${eAlign.mid.toFixed(2)}`);
      return finalize({
        action: 'HOLD',
        lane,
        urgency: 'patient',
        recommendedSize: 0,
        headline: `HOLD ${laneLabel(lane, upLabel, downLabel)}`,
        reason: 'Already aligned with the consensus lane — let the trade work.',
        evidence,
        confidence: conf(agreement),
        defensive: false,
      });
    }

    // Position opposite consensus — FLIP if confidence high, else TRIM/HOLD.
    const eFlip = laneEdge(lane);
    const edgeFlipUsd = eFlip?.edgePerShareUsd ?? null;
    const wantFlip =
      agreement >= 65 &&
      (fStatus === 'SWITCH_INCOMING' || fStatus === 'GO_IN' || fStatus === 'EXIT') &&
      (cross == null || cross >= 0.35) &&
      regime !== 'chop' &&
      (edgeFlipUsd == null || edgeFlipUsd >= 0.02);
    if (wantFlip) {
      const switchForming = fStatus === 'SWITCH_INCOMING';
      const heldLab = laneLabel(currentPositionLane, upLabel, downLabel);
      const targetLab = laneLabel(lane, upLabel, downLabel);
      evidence.push(`Consensus flipped to ${targetLab} (${agreement}%)`);
      if (cross != null) evidence.push(`Cross prob ${Math.round(cross * 100)}%`);
      if (eFlip) evidence.push(`Edge ${eFlip.edgePerShareUsd >= 0 ? '+' : ''}${eFlip.edgePerShareUsd.toFixed(2)}/share at mid ${eFlip.mid.toFixed(2)}`);
      if (forecast) evidence.push(`Forecast: ${fStatus} ${fConf}`);
      if (switchForming) {
        evidence.push(
          `Two-leg order: fully exit ${heldLab} (or to your plan) and confirm fills before adding ${targetLab} — do not race the new buy against an open ${heldLab} sell.`,
        );
      }
      const size = sizeFor({
        agreement,
        cross,
        regime,
        urgency,
        defensive: false,
        acceleration,
        mtf,
        overextension: overext,
        edgeUsd: edgeFlipUsd,
        focusLane: lane,
      });
      // SWITCH_INCOMING is an early heads-up — "ACT NOW" on the new leg trains people to
      // mishandle the held exit (e.g. long UP while card screams DOWN). Keep urgency calm
      // until the strip promotes GO_IN / EXIT, or agreement is extreme.
      const flipUrgency: DirectiveUrgency = switchForming
        ? agreement >= 88
          ? 'now'
          : 'soon'
        : agreement >= 75
          ? 'now'
          : 'soon';
      return finalize({
        action: 'FLIP',
        lane,
        urgency: flipUrgency,
        recommendedSize: size,
        headline: switchForming
          ? `FLIP → ${targetLab} — exit ${heldLab} first`
          : `FLIP TO ${targetLab}`,
        reason: switchForming
          ? `Switch toward ${targetLab} is still forming — prioritize a clean ${heldLab} exit before sizing ${targetLab}.`
          : `Held ${heldLab} fading and ${targetLab} consensus is dominant — close + reverse.`,
        evidence,
        confidence: conf(agreement),
        defensive: false,
      });
    }
    if (agreement >= 50) {
      evidence.push(`Consensus: ${laneLabel(lane, upLabel, downLabel)} ${agreement}%`);
      if (cross != null) evidence.push(`Cross prob ${Math.round(cross * 100)}%`);
      return finalize({
        action: 'TRIM',
        lane: currentPositionLane,
        urgency: 'soon',
        recommendedSize: 0,
        headline: `TRIM ${laneLabel(currentPositionLane, upLabel, downLabel)}`,
        reason: 'Consensus has tilted opposite — reduce exposure ahead of a possible flip.',
        evidence,
        confidence: 'MED',
        defensive: true,
      });
    }
    return finalize({
      action: 'HOLD',
      lane: currentPositionLane,
      urgency: 'patient',
      recommendedSize: 0,
      headline: `HOLD ${laneLabel(currentPositionLane, upLabel, downLabel)}`,
      reason: 'Edge is mixed — not strong enough to flip; keep current exposure.',
      evidence: [`Agreement only ${agreement}%`, `Regime: ${regime}`],
      confidence: 'LOW',
      defensive: false,
    });
  }

  // ─── 3) Flat — INITIATE if the stack is loud enough; STAND_DOWN otherwise.
  //
  // Operator feedback: prior thresholds were too defensive — the directive sat
  // in WATCH/STAND_DOWN whenever any guard fired (chop / conflict / overextended
  // / negative-EV / forecast-WAIT), which made the system "not help" even when
  // 4+ sensors clearly agreed. Loosened thresholds below + a new LOW-conviction
  // PROBE branch at 55–64 agreement so we always *commit* when sensors lean,
  // just with smaller size when conviction is thin.

  // Choppy regime: only veto when agreement is genuinely weak (< 40).
  if (regime === 'chop' && agreement < 40) {
    return {
      ...STAND_DOWN,
      headline: 'WAIT — CHOPPY',
      reason: 'Regime is choppy and agreement is too weak to fight it.',
      evidence: [`Agreement ${agreement}%`, 'Regime: CHOP'],
    };
  }
  // Implied↔spot conflict: only veto on weak agreement; with 60%+ the rest of the
  // stack outweighs the implied/spot disagreement.
  if (probVsSpot === 'conflict' && agreement < 40) {
    return {
      ...STAND_DOWN,
      headline: 'WAIT — CONFLICT',
      reason: 'Implied probability and spot vs PTB disagree and agreement is thin.',
      evidence: [`Agreement ${agreement}%`, 'Align: conflict (spot vs implied)'],
    };
  }
  // Overextension anti-chase: only veto when agreement is below 70 (was 80).
  // Strong consensus can override overextension — that's a confirmed trend, not a chase.
  const chasingExtended =
    overext && overext.state === 'overextended' && overext.direction === lane;
  const eLane = laneEdge(lane);
  const edgeUsd = eLane?.edgePerShareUsd ?? null;
  const negativeEv = edgeUsd != null && edgeUsd < 0;
  if (chasingExtended && agreement < 50) {
    return {
      action: 'STAND_DOWN',
      lane,
      urgency: 'patient',
      recommendedSize: 0,
      headline: `WATCH ${laneLabel(lane, upLabel, downLabel)} — OVEREXTENDED`,
      reason: `Move ratio ${overext?.ratio.toFixed(1)}× baseline — wait for a pullback before chasing.`,
      evidence: [
        overext?.summary ?? '',
        `Agreement ${agreement}% on ${laneLabel(lane, upLabel, downLabel)}`,
        eLane ? `Edge ${eLane.edgePerShareUsd >= 0 ? '+' : ''}${eLane.edgePerShareUsd.toFixed(2)}/share` : '',
      ].filter(Boolean),
      confidence: 'LOW',
      defensive: true,
      edgePerShareUsd: edgeUsd,
      laneMid: eLane?.mid ?? null,
      laneWinProb: eLane?.pWin ?? null,
      laneOutcomeLabel: lane === 'up' ? (upLabel ?? 'UP') : (downLabel ?? 'DOWN'),
    };
  }
  // Negative-EV consensus: only block when conviction is meh (was 85, now 70).
  // Above 70% agreement we let the user enter even on a slightly-overpriced lane.
  if (negativeEv && agreement < 50) {
    return {
      action: 'STAND_DOWN',
      lane,
      urgency: 'patient',
      recommendedSize: 0,
      headline: `WATCH ${laneLabel(lane, upLabel, downLabel)} — NEGATIVE EV`,
      reason: `Market mid ${eLane?.mid.toFixed(2)} > model ${Math.round((eLane?.pWin ?? 0) * 100)}% — entering here is −EV with thin conviction.`,
      evidence: [
        `Agreement ${agreement}% on ${laneLabel(lane, upLabel, downLabel)}`,
        eLane ? `Edge ${eLane.edgePerShareUsd.toFixed(2)}/share (negative)` : '',
        `Mid ${eLane?.mid.toFixed(2)} vs model ${Math.round((eLane?.pWin ?? 0) * 100)}%`,
      ].filter(Boolean),
      confidence: 'MED',
      defensive: true,
      edgePerShareUsd: edgeUsd,
      laneMid: eLane?.mid ?? null,
      laneWinProb: eLane?.pWin ?? null,
      laneOutcomeLabel: lane === 'up' ? (upLabel ?? 'UP') : (downLabel ?? 'DOWN'),
    };
  }

  // ─── INITIATE branches ────────────────────────────────────────────────────
  if (orderFlowConflictsLane(lane, machine)) {
    const flow = machine.flowWinningLane!;
    return {
      action: 'STAND_DOWN',
      lane,
      urgency: 'patient',
      recommendedSize: 0,
      headline: `WAIT — FLOW ${flow.toUpperCase()}`,
      reason: `Order flow (tape/book/walls) favors ${laneLabel(flow, upLabel, downLabel)} — do not INITIATE ${laneLabel(lane, upLabel, downLabel)} against live momentum.`,
      evidence: [
        `Flow winning: ${laneLabel(flow, upLabel, downLabel)}`,
        `Sensor vote: ${laneLabel(lane, upLabel, downLabel)} (${agreement}%)`,
        ...(machine.lines.filter((l) => /Order-flow|Flow lead|Tape/i.test(l)).slice(0, 2)),
      ],
      confidence: 'LOW',
      defensive: true,
      edgePerShareUsd: edgeUsd,
      laneMid: eLane?.mid ?? null,
      laneWinProb: eLane?.pWin ?? null,
      laneOutcomeLabel: lane === 'up' ? (upLabel ?? 'UP') : (downLabel ?? 'DOWN'),
    };
  }

  // We *commit* whenever agreement >= 65 — the forecaster being patient (`WAIT`)
  // shouldn't block the call, it just means we're not in a hot triple-confirm
  // window. Forecast `EXIT` on the focus lane downgrades to LOW conviction but
  // still allows the trade if other sensors override. LOW-confidence EXIT is treated as
  // noise so we do not block INITIATE / flash immediate exit on a single thin slice.
  const forecastForbids =
    fStatus === 'EXIT' && forecast?.lane === lane && forecast.confidence === 'HIGH';
  if (agreement >= 52 && !forecastForbids) {
    const size = sizeFor({
      agreement,
      cross,
      regime,
      urgency,
      defensive: false,
      acceleration,
      mtf,
      overextension: overext,
      edgeUsd,
      focusLane: lane,
    });
    evidence.push(`Agreement ${agreement}% on ${laneLabel(lane, upLabel, downLabel)}`);
    if (cross != null) evidence.push(`Cross prob ${Math.round(cross * 100)}%`);
    if (eLane) evidence.push(`Edge ${eLane.edgePerShareUsd >= 0 ? '+' : ''}${eLane.edgePerShareUsd.toFixed(2)}/share at mid ${eLane.mid.toFixed(2)}`);
    if (mtf && mtf.dominantLane === lane && mtf.fullAgreement) evidence.push('MTF stack: 4/4 timeframes aligned');
    else if (mtf && mtf.hasConflict) evidence.push('MTF stack: conflicting timeframes');
    if (acceleration && acceleration.state !== 'idle') evidence.push(acceleration.summary);
    if (overext && overext.state === 'stretched') evidence.push(`Stretched ×${overext.ratio.toFixed(1)} — half-size`);
    if (urgency !== 'low') evidence.push(`Urgency: ${urgency.toUpperCase()}`);
    if (fStatus === 'WAIT') evidence.push('Forecaster patient (WAIT) — sensor consensus carrying the call.');
    return {
      action: 'INITIATE',
      lane,
      urgency: urgency === 'critical' ? 'now' : agreement >= 75 ? 'now' : 'soon',
      recommendedSize: size,
      headline: `INITIATE ${laneLabel(lane, upLabel, downLabel)}`,
      reason: `Consensus ${agreement}% on ${laneLabel(lane, upLabel, downLabel)} with ${
        regime === 'trend' ? 'trending' : regime === 'grind' ? 'grinding' : 'choppy'
      } regime — entry conditions met.`,
      evidence,
      confidence: conf(agreement),
      defensive: false,
      edgePerShareUsd: edgeUsd,
      laneMid: eLane?.mid ?? null,
      laneWinProb: eLane?.pWin ?? null,
      laneOutcomeLabel: lane === 'up' ? (upLabel ?? 'UP') : (downLabel ?? 'DOWN'),
    };
  }

  // PROBE branch: 50–57 agreement with at least mildly non-negative EV → small INITIATE
  // with LOW confidence rather than WATCH. In **chop**, require 54%+ for a probe.
  if (
    agreement >= 45 &&
    !forecastForbids &&
    (regime !== 'chop' || agreement >= 48) &&
    (edgeUsd == null || edgeUsd >= -0.03)
  ) {
    const baseSize = sizeFor({
      agreement,
      cross,
      regime,
      urgency,
      defensive: false,
      acceleration,
      mtf,
      overextension: overext,
      edgeUsd,
      focusLane: lane,
    });
    const probeSize = Math.max(0.1, baseSize * 0.5);
    evidence.push(`Agreement ${agreement}% on ${laneLabel(lane, upLabel, downLabel)} — probe size`);
    if (eLane) evidence.push(`Edge ${eLane.edgePerShareUsd >= 0 ? '+' : ''}${eLane.edgePerShareUsd.toFixed(2)}/share`);
    if (cross != null) evidence.push(`Cross prob ${Math.round(cross * 100)}%`);
    return {
      action: 'INITIATE',
      lane,
      urgency: 'soon',
      recommendedSize: probeSize,
      headline: `PROBE ${laneLabel(lane, upLabel, downLabel)}`,
      reason: `Sensor lean toward ${laneLabel(lane, upLabel, downLabel)} (${agreement}%) — half-size probe; add on confirmation.`,
      evidence,
      confidence: 'LOW',
      defensive: false,
      edgePerShareUsd: edgeUsd,
      laneMid: eLane?.mid ?? null,
      laneWinProb: eLane?.pWin ?? null,
      laneOutcomeLabel: lane === 'up' ? (upLabel ?? 'UP') : (downLabel ?? 'DOWN'),
    };
  }

  // Last resort: only stand down when agreement is genuinely weak (<45) or the
  // forecaster explicitly says EXIT this lane (HIGH confidence).
  if (forecastForbids) {
    return {
      ...STAND_DOWN,
      headline: 'WAIT — FORECAST EXIT',
      reason: `Forecaster flagged EXIT on ${laneLabel(lane, upLabel, downLabel)} — wait for it to clear.`,
      evidence: [`Agreement ${agreement}%`, `Forecast: ${fStatus}/${fConf}`],
    };
  }
  return {
    ...STAND_DOWN,
    headline: 'WAIT — NO EDGE',
    reason: 'Sensors split or weak — no actionable trade right now.',
    evidence: [`Agreement ${agreement}%`, `Regime: ${regime}`],
  };
}
