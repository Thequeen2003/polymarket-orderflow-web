/**
 * Composite “machine” readout for Spot vs PTB — fuses independent sensors so the UI
 * can show agreement score, regime, urgency, and prob↔spot alignment in one place.
 */

import type { SpotSection } from './sectionalMomentum';
import type { PtbCrossEstimate, EndingProbability } from './ptbCrossProbability';
import type { MomentumAcceleration } from './momentumAcceleration';
import type { MtfConsensus } from './multiTimeframeConsensus';
import type { Overextension } from './overextensionDetector';
import type { LaneEdges } from './tradeEdgeCalculator';
import type { TapeVelocity } from './tapeVelocity';
import type { DualOutcomeWallFlow } from './dualOutcomeWalls';

export type MarketRegime = 'trend' | 'chop' | 'grind';
export type UrgencyTier = 'settlement' | 'critical' | 'high' | 'med' | 'low';
export type ProbVsSpot = 'aligned' | 'conflict' | 'stretch' | 'unknown';

export type SpotPtbMachineReadout = {
  /** How many independent sensors agree on `focusLane`, weighted 0–100. */
  agreementScore: number;
  /** Lane the score is about (null if split / unclear). */
  focusLane: 'up' | 'down' | null;
  /**
   * Raw weighted vote tallies for each lane. Useful for transparency UI
   * (a "UP 4.2 / DOWN 2.1" mini-bar) and to debug directive-disagreement claims.
   */
  laneVotes: { up: number; down: number };
  regime: MarketRegime;
  urgency: UrgencyTier;
  probVsSpot: ProbVsSpot;
  /** Probability spot crosses PTB before round end (0..1, null when unknown). */
  crossProb: number | null;
  /** Full cross-probability estimate (drift, vol, etc.) for tooltips. */
  crossEstimate: PtbCrossEstimate | null;
  /** Acceleration state from the momentum detector. */
  acceleration: MomentumAcceleration | null;
  /** Multi-timeframe consensus stack (1m/5m/15m/30m drift votes). */
  mtf: MtfConsensus | null;
  /** Anti-chase guard — flags when the recent move is unusually large. */
  overextension: Overextension | null;
  /** P(spot ends above/below PTB at bell). */
  endingProb: EndingProbability | null;
  /** Per-lane $ edge derived from `endingProb` and current implied mids. */
  edges: LaneEdges | null;
  /**
   * Book + implied + drift + tape majority — the CLOB “winning side” independent of
   * spot vs PTB geometry (e.g. spot above PTB while DOWN flow leads).
   */
  flowWinningLane: 'up' | 'down' | null;
  /** UP/DOWN token bid-wall / ask-wall read (primary flow input when present). */
  wallFlow: DualOutcomeWallFlow | null;
  /** Individual sensor hints for debugging / tooltips. */
  sensors: {
    spotVsPtb: 'up' | 'down' | 'at' | null;
    impliedLeader: 'up' | 'down' | null;
    sectionalDrift: 'up' | 'down' | null;
    bookControl: 'up' | 'down' | null;
    microSlope: 'up' | 'down' | 'flat';
    dwellBias: 'up' | 'down' | null;
    accel: MomentumAcceleration['state'];
    mtfDominant: 'up' | 'down' | null;
    overextended: 'up' | 'down' | null;
    /** Outcome-tape aggressor read (when prints are wired in). */
    tapeDominance: TapeVelocity['dominance'] | null;
    tapeReliable: boolean;
    upBidWall: boolean;
    upAskWall: boolean;
    downBidWall: boolean;
    downAskWall: boolean;
  };
  /** 3–5 short lines for the banner / strip. */
  lines: string[];
};

function spotVsPtbSide(spot: number, ptb: number, bandUsd: number): 'up' | 'down' | 'at' {
  const half = Math.max(bandUsd * 0.45, 0.25);
  if (spot > ptb + half) return 'up';
  if (spot < ptb - half) return 'down';
  return 'at';
}

function impliedLeader(probUp: number | null, probDown: number | null): 'up' | 'down' | null {
  let u = probUp != null && Number.isFinite(probUp) ? probUp : null;
  let d = probDown != null && Number.isFinite(probDown) ? probDown : null;
  // Same complement idea as `computeLaneEdges`: CLOB/RTDS often ships one mid;
  // without this, implied stays null and DOWN can "disappear" from the vote tally.
  if (u != null && d == null) d = 1 - u;
  else if (d != null && u == null) u = 1 - d;
  if (u == null || d == null) return null;
  u = Math.max(0.001, Math.min(0.999, u));
  d = Math.max(0.001, Math.min(0.999, d));
  if (d > u + 0.02) return 'down';
  if (u > d + 0.02) return 'up';
  return null;
}

function controlToLane(control: string | null | undefined): 'up' | 'down' | null {
  if (control === 'UP_CONTROL') return 'up';
  if (control === 'DOWN_CONTROL') return 'down';
  return null;
}

function microSlopeSign2(slopeUsdPerSec: number | null, bandUsd: number): 'up' | 'down' | 'flat' {
  if (slopeUsdPerSec == null || !Number.isFinite(slopeUsdPerSec)) return 'flat';
  const th = Math.max(bandUsd / 60, 1e-9);
  if (slopeUsdPerSec > th) return 'up';
  if (slopeUsdPerSec < -th) return 'down';
  return 'flat';
}

function dwellToLane(sign: -1 | 0 | 1): 'up' | 'down' | null {
  if (sign > 0) return 'up';
  if (sign < 0) return 'down';
  return null;
}

/**
 * Order-flow winning side from book control, implied mids, sectional drift, and tape.
 * Used to down-weight bare PTB geometry when spot and the board disagree.
 */
export function computeFlowWinningLane(args: {
  bookControl: 'up' | 'down' | null;
  impliedLeader: 'up' | 'down' | null;
  sectionalDrift: 'up' | 'down' | null;
  tapeLane: 'up' | 'down' | null;
  tapeDominance: TapeVelocity['dominance'] | null;
  tapeReliable: boolean;
  /** Bid/ask walls on UP + DOWN books — weighted highest when set. */
  wallFlowLane?: 'up' | 'down' | null;
  wallPressure?: number | null;
}): 'up' | 'down' | null {
  type L = 'up' | 'down';
  const votes: Record<L, number> = { up: 0, down: 0 };
  const add = (lane: L | null, w: number) => {
    if (lane === 'up') votes.up += w;
    else if (lane === 'down') votes.down += w;
  };
  if (args.wallFlowLane) {
    let w = 3.55;
    const p = args.wallPressure;
    if (p != null && Number.isFinite(p) && Math.abs(p) >= 1.1) w += 0.55;
    add(args.wallFlowLane, w);
  }
  if (args.bookControl) add(args.bookControl, 1.65);
  if (args.impliedLeader) add(args.impliedLeader, 1.45);
  if (args.sectionalDrift) add(args.sectionalDrift, 1.2);
  if (args.tapeReliable && args.tapeLane && args.tapeDominance) {
    add(tapeLaneVote(args.tapeLane, args.tapeDominance), 1.75);
  }
  const margin = 0.34;
  if (votes.up >= votes.down + margin) return 'up';
  if (votes.down >= votes.up + margin) return 'down';
  return null;
}

/** Aggressor tape on one outcome token → UP/DOWN lane vote. */
export function tapeLaneVote(tapeLane: 'up' | 'down', dominance: TapeVelocity['dominance']): 'up' | 'down' | null {
  if (dominance === 'mixed' || dominance === 'idle') return null;
  if (tapeLane === 'up') return dominance === 'buy' ? 'up' : 'down';
  return dominance === 'buy' ? 'down' : 'up';
}

/** True when reliable tape or bid/ask walls show flow on the opposite side of `lane`. */
export function orderFlowConflictsLane(
  lane: 'up' | 'down',
  machine: Pick<SpotPtbMachineReadout, 'flowWinningLane' | 'sensors' | 'wallFlow'>,
): boolean {
  const flow = machine.flowWinningLane;
  if (!flow || flow === lane) return false;
  const dom = machine.sensors.tapeDominance;
  const tapeStrong =
    machine.sensors.tapeReliable && dom != null && dom !== 'mixed' && dom !== 'idle';
  const wallLane = machine.wallFlow?.flowLane ?? null;
  const wallStrong = wallLane != null && wallLane === flow;
  return tapeStrong || wallStrong;
}

/**
 * After the weighted sensor vote, align `focusLane` with order-flow momentum when
 * tape/book/walls disagree with a PTB-geometry-heavy tally.
 */
export function resolveFocusLaneWithOrderFlow(args: {
  votedLane: 'up' | 'down' | null;
  flowWinningLane: 'up' | 'down' | null;
  tapeReliable: boolean;
  tapeDominance: TapeVelocity['dominance'] | null;
  wallFlowLane: 'up' | 'down' | null;
}): { lane: 'up' | 'down' | null; overrideNote: string | null } {
  const { votedLane, flowWinningLane, tapeReliable, tapeDominance, wallFlowLane } = args;
  if (!votedLane || !flowWinningLane || votedLane === flowWinningLane) {
    return { lane: votedLane, overrideNote: null };
  }
  const tapeStrong =
    tapeReliable && tapeDominance != null && tapeDominance !== 'mixed' && tapeDominance !== 'idle';
  const wallStrong = wallFlowLane != null;
  if (wallStrong || tapeStrong) {
    return {
      lane: flowWinningLane,
      overrideNote: `Order-flow override: sensors tallied ${votedLane.toUpperCase()} but ${
        wallStrong ? 'walls' : 'tape'
      }/book favor ${flowWinningLane.toUpperCase()} — trade momentum, not PTB geometry alone.`,
    };
  }
  return {
    lane: votedLane,
    overrideNote: `Flow split: sensors ${votedLane.toUpperCase()} vs book ${flowWinningLane.toUpperCase()} — soft tape/walls; PTB lean kept, confirm size.`,
  };
}

function sectionalDriftLane(sections: SpotSection[], bandUsd: number): 'up' | 'down' | null {
  if (sections.length < 1) return null;
  const w2 = sections.slice(-2);
  const driftNet = w2.reduce((s, x) => s + x.netUsd, 0);
  if (Math.abs(driftNet) <= bandUsd * 0.8) return null;
  return driftNet > 0 ? 'up' : 'down';
}

function detectRegime(sections: SpotSection[]): MarketRegime {
  if (sections.length < 2) return 'grind';
  const avgAt = sections.reduce((s, x) => s + x.pctAtPtb, 0) / sections.length;
  const crosses = sections.reduce((s, x) => s + x.ptbCrosses, 0);
  if (avgAt > 0.38 && crosses >= Math.max(1, Math.floor(sections.length * 0.4))) return 'chop';
  const n = sections.length;
  const ups = sections.filter((s) => s.direction === 'UP').length;
  const dns = sections.filter((s) => s.direction === 'DOWN').length;
  if (n >= 3 && (ups >= n - 1 || dns >= n - 1)) return 'trend';
  return 'grind';
}

function urgencyFromEnds(endsInMs: number | null | undefined): UrgencyTier {
  if (endsInMs == null || !Number.isFinite(endsInMs) || endsInMs <= 0) return 'low';
  if (endsInMs <= 60_000) return 'settlement';
  if (endsInMs <= 5 * 60_000) return 'critical';
  if (endsInMs <= 12 * 60_000) return 'high';
  if (endsInMs <= 40 * 60_000) return 'med';
  return 'low';
}

function probVsSpotClass(
  spotSide: 'up' | 'down' | 'at',
  implied: 'up' | 'down' | null,
): ProbVsSpot {
  if (implied == null) return 'unknown';
  if (spotSide === 'at') return 'stretch';
  if (spotSide === implied) return 'aligned';
  return 'conflict';
}

/**
 * Weighted agreement: book + spot + implied count double if they match focus.
 */
export function computeSpotPtbMachineReadout(args: {
  sections: SpotSection[];
  spot: number | null;
  ptb: number | null;
  bandUsd: number;
  lastProbUp: number | null;
  lastProbDown: number | null;
  controlSignal: string;
  dwellMajoritySign: -1 | 0 | 1;
  slopeUsdPerSec: number | null;
  primaryLane: 'up' | 'down' | null;
  endsInMs: number | null;
  crossEstimate?: PtbCrossEstimate | null;
  acceleration?: MomentumAcceleration | null;
  mtf?: MtfConsensus | null;
  overextension?: Overextension | null;
  endingProb?: EndingProbability | null;
  edges?: LaneEdges | null;
  /** CLOB tape for one outcome (UP or DOWN token) — buy/sell aggressor flow. */
  tape?: TapeVelocity | null;
  tapeLane?: 'up' | 'down' | null;
  /** Both outcome books — bid wall / ask wall on each (primary flow when present). */
  wallFlow?: DualOutcomeWallFlow | null;
}): SpotPtbMachineReadout {
  const { bandUsd, lastProbUp, lastProbDown, controlSignal, dwellMajoritySign, slopeUsdPerSec, primaryLane, endsInMs } = args;
  const spot = args.spot;
  const ptb = args.ptb;
  const sections = args.sections;
  const crossEstimate = args.crossEstimate ?? null;
  const acceleration = args.acceleration ?? null;
  const mtf = args.mtf ?? null;
  const overextension = args.overextension ?? null;
  const endingProb = args.endingProb ?? null;
  const edges = args.edges ?? null;
  const tape = args.tape ?? null;
  const tapeLane = args.tapeLane ?? null;

  const implied = impliedLeader(lastProbUp, lastProbDown);
  const book = controlToLane(controlSignal);
  const micro = microSlopeSign2(slopeUsdPerSec, bandUsd);
  const dwellB = dwellToLane(dwellMajoritySign);
  const drift = sectionalDriftLane(sections, bandUsd);

  let spotSide: 'up' | 'down' | 'at' = 'at';
  if (spot != null && ptb != null && Number.isFinite(spot) && Number.isFinite(ptb)) {
    spotSide = spotVsPtbSide(spot, ptb, bandUsd);
  }

  const overextDir: 'up' | 'down' | null =
    overextension && overextension.state === 'overextended' && overextension.direction !== 'flat'
      ? (overextension.direction as 'up' | 'down')
      : null;

  const tapeReliable = tape?.reliable === true;
  const tapeDom = tapeReliable ? tape.dominance : null;
  const wallFlow = args.wallFlow ?? null;
  const flowWinningLane = computeFlowWinningLane({
    bookControl: book,
    impliedLeader: implied,
    sectionalDrift: drift,
    tapeLane: tapeLane ?? null,
    tapeDominance: tapeDom,
    tapeReliable,
    wallFlowLane: wallFlow?.flowLane ?? null,
    wallPressure: wallFlow?.pressure ?? null,
  });

  const sensors = {
    spotVsPtb: spotSide === 'at' ? null : spotSide,
    impliedLeader: implied,
    sectionalDrift: drift,
    bookControl: book,
    microSlope: micro,
    dwellBias: dwellB,
    accel: acceleration?.state ?? 'idle',
    mtfDominant: mtf?.dominantLane ?? null,
    overextended: overextDir,
    tapeDominance: tapeDom,
    tapeReliable,
    upBidWall: wallFlow?.up?.bidWall === true,
    upAskWall: wallFlow?.up?.askWall === true,
    downBidWall: wallFlow?.down?.bidWall === true,
    downAskWall: wallFlow?.down?.askWall === true,
  } as const;

  const regime = detectRegime(sections);
  const urgency = urgencyFromEnds(endsInMs);
  const probVsSpot = probVsSpotClass(spotSide, implied);

  // ─── Weighted lane vote ──────────────────────────────────────────────────
  //
  // Previously this was "first non-null sensor wins" which made the highest-
  // priority sensor (usually spotVsPtb) dictate the directive even when 4+
  // other sensors (drift, MTF, EV edge) all pointed the *opposite* way. That's
  // exactly the wrong-side bug operators noticed on rangy markets where spot
  // hovers just past PTB but every momentum + EV channel says "the other side".
  //
  // We now tally per-lane weighted votes from every sensor (including the
  // model's terminal-probability winner from `edges.bestLane` when edge is
  // material) and pick the lane with the larger weight. There is **no** vote
  // from the chart `primaryLane` — that used to skew close calls toward UP.
  // When the vote is too close to call, focusLane is null → STAND_DOWN.
  type L = 'up' | 'down';
  const votes: Record<L, number> = { up: 0, down: 0 };
  const voteAdd = (lane: L | null, w: number) => {
    if (lane === 'up') votes.up += w;
    else if (lane === 'down') votes.down += w;
  };

  if (sensors.spotVsPtb) {
    let w = 0.85;
    const wallLane = wallFlow?.flowLane ?? null;
    const flowRef = wallLane ?? flowWinningLane;
    if (flowRef && sensors.spotVsPtb !== flowRef) w = wallLane ? 0.18 : 0.28;
    else if (flowRef && sensors.spotVsPtb === flowRef) w = 1.05;
    voteAdd(sensors.spotVsPtb, w);
  }
  if (wallFlow?.flowLane) {
    voteAdd(wallFlow.flowLane, 2.85);
  }
  if (sensors.impliedLeader) voteAdd(sensors.impliedLeader, 1.55);
  if (sensors.sectionalDrift) voteAdd(sensors.sectionalDrift, 1.4);
  if (sensors.bookControl) voteAdd(sensors.bookControl, 1.65);
  if (sensors.microSlope !== 'flat') voteAdd(sensors.microSlope, 1.05);
  if (sensors.dwellBias) voteAdd(sensors.dwellBias, 1.05);
  if (tape?.reliable && tapeLane) {
    const tl = tapeLaneVote(tapeLane, tape.dominance);
    let w = 2.05;
    if (tape.burst === 'aggressive') w += 0.3;
    if (tape.burst === 'extreme') w += 0.5;
    if (Math.abs(tape.netPressure) >= 35) w += 0.2;
    voteAdd(tl, w);
  }
  // Micro-window leading indicator: 10s tape acceleration fires before full 30s confirms.
  // Catches directional moves ~15-20s earlier than waiting for the full window.
  if (tape?.microReliable && tapeLane) {
    const microLane = tapeLaneVote(tapeLane, tape.microDominance);
    if (microLane) {
      let mw = 0;
      if (tape.acceleration === 'surging') mw = 1.8;
      else if (tape.acceleration === 'building') mw = 1.0;
      if (tape.microBurstRatio >= 3) mw += 0.5;
      if (Math.abs(tape.microNetPressure) >= 55) mw += 0.4;
      if (mw > 0) voteAdd(microLane, mw);
    }
  }
  if (endingProb && endingProb.confidence !== 'low') {
    const pAbove = endingProb.endAboveProb;
    const endLane: L | null = pAbove >= 0.56 ? 'up' : pAbove <= 0.44 ? 'down' : null;
    if (endLane) {
      const w = endingProb.confidence === 'high' ? 1.15 : 0.75;
      voteAdd(endLane, w);
    }
  }
  if (acceleration && (acceleration.state === 'accel-up' || acceleration.state === 'accel-down')) {
    voteAdd(acceleration.direction === 'up' ? 'up' : 'down', 1.1);
  }
  if (mtf && mtf.dominantLane) {
    const w = mtf.fullAgreement ? 1.8 : mtf.alignedCount >= 3 ? 1.4 : mtf.alignedCount >= 2 ? 1.0 : 0.6;
    const adjusted = mtf.hasConflict ? w * 0.7 : w;
    voteAdd(mtf.dominantLane, adjusted);
  }
  // Model-EV edge — strong vote for the side the terminal probability favors.
  // Only counts when the edge is meaningfully positive (≥5¢ → MED+).
  if (edges?.bestLane && edges.bestEdgeUsd >= 0.05) {
    const w = edges.bestEdgeUsd >= 0.12 ? 1.6 : 1.2; // HIGH vs MED bucket
    voteAdd(edges.bestLane, w);
  }
  // Intentionally no `primaryLane` vote: the chart's primary call often leans UP when
  // spot is barely above PTB; adding even a tiny weight systematically flipped close
  // tallies toward UP and felt "rigged" vs DOWN in practice.

  // Vote-margin: modest lead to pick a lane; lean fallback avoids endless WAIT on close calls.
  const VOTE_MARGIN = 0.22;
  const LEAN_MARGIN = 0.1;
  let focusLane: L | null = null;
  if (votes.up > 0 || votes.down > 0) {
    if (votes.up >= votes.down + VOTE_MARGIN) focusLane = 'up';
    else if (votes.down >= votes.up + VOTE_MARGIN) focusLane = 'down';
    else if (votes.up >= votes.down + LEAN_MARGIN) focusLane = 'up';
    else if (votes.down >= votes.up + LEAN_MARGIN) focusLane = 'down';
  }

  // Edge-veto: only fires when the model is *very* sure the other side wins
  // AND our picked side is meaningfully −EV (not just neutral). Was 0.08 +
  // ≤0 → felt too aggressive. Now requires a 12¢ counter-edge AND ≥2¢ negative
  // edge on the picked side, so a thin price imbalance can't nuke a call.
  //
  // When the **weighted sensor lead** is wide (tape + book + implied all lining
  // up), operators still want that lane even if the terminal model is stuck on
  // the other outcome — otherwise perfect DOWN prints never produced ENTER DOWN.
  const voteLeadFor = (lane: L) => (lane === 'up' ? votes.up - votes.down : votes.down - votes.up);
  const EDGE_VETO_SENSOR_BYPASS = 1.0; // sensor lead overrides terminal EV when tape+book agree
  let edgeVetoSensorBypassNote: string | null = null;
  if (
    focusLane &&
    edges?.bestLane &&
    edges.bestLane !== focusLane &&
    edges.bestEdgeUsd >= 0.18
  ) {
    const focusEdge = focusLane === 'up' ? edges.up : edges.down;
    if (focusEdge && focusEdge.edgePerShareUsd <= -0.04) {
      const lead = voteLeadFor(focusLane);
      // When spot vs PTB and implied mids already agree on the vote winner, do not
      // wipe the lane purely because terminal EV prefers the other outcome — that
      // combination produced "no INITIATE / no BOOM" moments where tape + YES/NO
      // prices clearly favored UP (or DOWN) but the model lagged.
      const tapeAndImpliedAgreeFocus =
        probVsSpot === 'aligned' && implied != null && implied === focusLane;
      if (lead < EDGE_VETO_SENSOR_BYPASS && !tapeAndImpliedAgreeFocus) {
        focusLane = null;
      } else {
        edgeVetoSensorBypassNote = `EV favors ${edges.bestLane.toUpperCase()} but sensor lead ${lead.toFixed(
          1,
        )} keeps ${focusLane.toUpperCase()} — tape vs terminal model split.`;
      }
    }
  }

  const votedLane = focusLane;
  const flowAlign = resolveFocusLaneWithOrderFlow({
    votedLane,
    flowWinningLane,
    tapeReliable,
    tapeDominance: tapeDom,
    wallFlowLane: wallFlow?.flowLane ?? null,
  });
  focusLane = flowAlign.lane;
  const flowOverrideNote = flowAlign.overrideNote;

  // ─── Agreement score (fraction of weighted votes aligned with focusLane) ──
  const t: L | null = focusLane;
  const totalWeight = votes.up + votes.down;
  const alignedWeight = t ? votes[t] : 0;
  // Reversing acceleration ticks against the focus lane (denominator-only).
  let den = totalWeight;
  let num = alignedWeight;
  if (acceleration && acceleration.state === 'reversing' && t) {
    den += 1;
  }
  // Overextension penalty against the move's direction (mean-reversion risk).
  if (overextDir && t && overextDir === t) {
    den += 1.0;
  }

  let agreementScore =
    den > 0 && t ? Math.round(Math.min(100, (num / den) * 100 + (num >= den - 0.01 ? 5 : 0))) : 0;
  if (!t) agreementScore = 0;

  const lines: string[] = [];
  if (t) {
    lines.push(
      `Machine agreement ${agreementScore}% on ${t.toUpperCase()} · regime ${regime.toUpperCase()} · time ${urgency.toUpperCase()}`,
    );
    // Surface a transparency line when the weighted vote disagrees with the
    // primary call — operators were seeing "wrong side" before this; now they
    // can see the rationale ("primary said UP but 4/6 sensors + EV say DOWN").
    if (primaryLane && primaryLane !== t) {
      lines.push(
        `Lane override: primary=${primaryLane.toUpperCase()} but weighted vote ${votes.up.toFixed(1)} UP / ${votes.down.toFixed(1)} DOWN → ${t.toUpperCase()}.`,
      );
    }
    if (edgeVetoSensorBypassNote) lines.push(edgeVetoSensorBypassNote);
    if (flowOverrideNote) lines.push(flowOverrideNote);
  } else if (primaryLane) {
    lines.push(
      `Machine: sensors split (${votes.up.toFixed(1)} UP / ${votes.down.toFixed(1)} DOWN) — too close to act.`,
    );
  } else {
    if (flowOverrideNote) lines.push(flowOverrideNote);
    else lines.push(`Machine: sensors split — no single lane yet (${regime} session).`);
  }

  if (wallFlow?.headline) lines.push(wallFlow.headline);
  if (wallFlow?.bidWarnings.length) {
    for (const w of wallFlow.bidWarnings) lines.push(`Wall bid warn: ${w.text}`);
  }
  if (flowWinningLane && spotSide !== 'at' && spotSide !== flowWinningLane) {
    lines.push(
      `Flow lead ${flowWinningLane.toUpperCase()} (walls/book/tape) vs spot ${spotSide.toUpperCase()} vs PTB — trade the winning side on the book, not PTB geometry alone.`,
    );
  }
  if (probVsSpot === 'conflict') {
    lines.push(`Conflict: implied favors ${implied?.toUpperCase()} but spot is ${spotSide === 'at' ? 'AT PTB' : spotSide.toUpperCase()} vs PTB — wait for one side to win.`);
  } else if (probVsSpot === 'aligned' && implied) {
    lines.push(`Spot & implied both lean ${implied.toUpperCase()} — tape aligned with underlying.`);
  } else if (probVsSpot === 'stretch' && implied) {
    lines.push(`Price AT PTB while implied leans ${implied.toUpperCase()} — breakout setup if spot commits.`);
  }

  if (crossEstimate && crossEstimate.confidence !== 'low') {
    const pct = Math.round(crossEstimate.prob * 100);
    if (pct >= 70) lines.push(`Cross prob ${pct}% — PTB likely flips before bell.`);
    else if (pct <= 15) lines.push(`Cross prob ${pct}% — PTB side likely holds.`);
  }
  if (acceleration && (acceleration.state === 'accel-up' || acceleration.state === 'accel-down')) {
    lines.push(`Thrust ${Math.round(acceleration.thrust)} — momentum accelerating ${acceleration.direction.toUpperCase()}.`);
  } else if (acceleration?.state === 'reversing') {
    lines.push('Reversal: late slope flipped against prior tape — fade strength carefully.');
  }
  if (mtf && mtf.dominantLane) {
    if (mtf.fullAgreement) {
      lines.push(`MTF stack: 4/4 timeframes ${mtf.dominantLane.toUpperCase()} — full conviction.`);
    } else if (mtf.hasConflict) {
      lines.push(`MTF stack: split (${mtf.alignedCount}/${mtf.totalActionable} on ${mtf.dominantLane.toUpperCase()}).`);
    }
  }
  if (overextension && overextension.state === 'overextended') {
    lines.push(`Anti-chase: ${overextension.direction.toUpperCase()} move ×${overextension.ratio.toFixed(1)} baseline — reversion risk.`);
  } else if (overextension && overextension.state === 'stretched') {
    lines.push(`Move stretched (×${overextension.ratio.toFixed(1)}) — size down on chase entries.`);
  }
  if (edges && edges.bestLane && edges.bestEdgeUsd >= 0.05) {
    const e = edges.bestLane === 'up' ? edges.up! : edges.down!;
    lines.push(`Edge: ${edges.bestLane.toUpperCase()} ${e.edgePerShareUsd >= 0 ? '+' : ''}${e.edgePerShareUsd.toFixed(2)}/share (model ${Math.round(e.pWin * 100)}% vs mid ${e.mid.toFixed(2)}).`);
  }
  if (tape?.reliable && tapeLane) {
    const tl = tapeLaneVote(tapeLane, tape.dominance);
    lines.push(
      `Tape (${tapeLane.toUpperCase()}): ${tape.dominance} aggressor · pressure ${tape.netPressure >= 0 ? '+' : ''}${Math.round(tape.netPressure)}${tl ? ` → ${tl.toUpperCase()}` : ''}.`,
    );
  }

  if (regime === 'chop') lines.push('CHOP: frequent PTB crosses — favor limits / smaller size.');
  if (urgency === 'settlement') lines.push('SETTLEMENT (<60s): exit risk only, do not chase new entries.');
  else if (urgency === 'critical') lines.push('Round ending soon — prioritize execution over perfect entry.');
  if (lines.length > 7) lines.splice(7);

  return {
    agreementScore,
    focusLane: t,
    flowWinningLane,
    wallFlow,
    laneVotes: { up: votes.up, down: votes.down },
    regime,
    urgency,
    probVsSpot,
    crossProb: crossEstimate?.prob ?? null,
    crossEstimate,
    acceleration,
    mtf,
    overextension,
    endingProb,
    edges,
    sensors,
    lines,
  };
}
