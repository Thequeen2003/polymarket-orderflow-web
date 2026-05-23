/**
 * Evidence-first system decision for Dual PTB belief UI (no “bias” framing).
 */

import type { ProbMicrostructure } from './ptbAdvancedContext';

export type SystemVerdict = 'ENTER' | 'WAIT' | 'SCALP';

export type EnterBlockReason = 'dual_lane_tight' | null;

export type PtbSystemDecision = {
  state: 'NEUTRAL';
  verdict: SystemVerdict;
  /** When both lanes are competitively tight, ENTER is suppressed (verdict forced to WAIT). */
  enterBlockReason: EnterBlockReason;
  edgeScore: number;
  edgeReasonLines: string[];
  evidence: { k: string; v: string }[];
  whyLines: string[];
  finalLine: string;
  enterIf: string[];
  invalidation: string[];
  conditionalNote: string | null;
  highlightGap: 'up' | 'down' | null;
  highlightWallProb: number | null;
  /** Short glossary line: regime vs chart execution gate. */
  regimeSubtitle: string;
  /** When both sides have competitive gaps — nudge away from one-sided momentum bias. */
  balanceNote: string | null;
  /** Echo inputs for UI (tape meter). */
  tapeSpeedLabel: 'SLOW' | 'MED' | 'FAST';
  tapeSpeedScore01: number;
  pathUpActive: boolean;
  pathDnActive: boolean;
  /** Short-horizon jump / opposing-leg context (optional). */
  microstructure: ProbMicrostructure | null;
};

type GapLite = { lo: number; hi: number; strength10: number; active: boolean; exitWall: number | null } | null;

function wallNear(prob: number, wall: number | null, side: 'above' | 'below'): boolean {
  if (wall == null) return false;
  const d = side === 'above' ? wall - prob : prob - wall;
  return d >= 0 && d <= 0.045;
}

export function computePtbSystemDecision(params: {
  lastU: number;
  lastD: number;
  distAbovePp: number;
  distBelowPp: number;
  upRising: boolean;
  dnRising: boolean;
  speedLabel: 'SLOW' | 'MED' | 'FAST';
  speedScore01: number;
  gapU: GapLite;
  gapD: GapLite;
  pathUpActive: boolean;
  pathDnActive: boolean;
  micro?: ProbMicrostructure | null;
}): PtbSystemDecision {
  const {
    lastU,
    lastD,
    distAbovePp,
    distBelowPp,
    upRising,
    dnRising,
    speedLabel,
    speedScore01,
    gapU,
    gapD,
    pathUpActive,
    pathDnActive,
    micro: microIn,
  } = params;
  const micro = microIn ?? null;

  const ptbDistUpAbs = Math.abs(distAbovePp);
  const ptbDistDnAbs = Math.abs(distBelowPp);
  const overUp = ptbDistUpAbs >= 24;
  const overDn = ptbDistDnAbs >= 24;

  const momU = upRising ? 'strengthening' : 'weak / stalled';
  const momD = dnRising ? 'strengthening' : 'weak / stalled';
  const momBlend =
    speedLabel === 'FAST' ? 'fast tape' : speedLabel === 'MED' ? 'medium tape' : 'slow tape';

  const gapUpTxt = gapU
    ? `${Math.round(gapU.lo * 100)}→${Math.round(gapU.hi * 100)}¢ (${gapU.active ? 'active' : 'inactive'})`
    : 'none detected';
  const gapDnTxt = gapD
    ? `${Math.round(gapD.lo * 100)}→${Math.round(gapD.hi * 100)}¢ (${gapD.active ? 'active' : 'inactive'})`
    : 'none detected';

  const wallUp = gapU?.exitWall;
  const wallDn = gapD?.exitWall;
  const liqU =
    wallUp != null
      ? wallNear(lastU, wallUp, 'above')
        ? `wall near ${(wallUp * 100).toFixed(0)}¢ (tight)`
        : `wall ${(wallUp * 100).toFixed(0)}¢ (${(wallUp - lastU) * 100 <= 8 ? 'close' : 'far'})`
      : 'no major wall parsed';
  const liqD =
    wallDn != null
      ? wallNear(lastD, wallDn, 'below')
        ? `wall near ${(wallDn * 100).toFixed(0)}¢ (tight)`
        : `wall ${(wallDn * 100).toFixed(0)}¢`
      : 'no major wall parsed';

  const evidence: { k: string; v: string }[] = [
    { k: 'PTB vs Up mid', v: `${distAbovePp >= 0 ? '+' : ''}${distAbovePp.toFixed(1)}¢${overUp ? ' · overextended' : ''}` },
    { k: 'PTB vs Down mid', v: `${distBelowPp >= 0 ? '+' : ''}${distBelowPp.toFixed(1)}¢${overDn ? ' · overextended' : ''}` },
    { k: 'Momentum (Up)', v: `${momU} · ${momBlend}` },
    { k: 'Momentum (Down)', v: `${momD} · ${momBlend}` },
    { k: 'Gap (Up)', v: gapUpTxt },
    { k: 'Gap (Down)', v: gapDnTxt },
    { k: 'Liquidity (Up)', v: liqU },
    { k: 'Liquidity (Down)', v: liqD },
  ];
  if (micro) {
    evidence.push({
      k: 'Micro (jump / chop)',
      v: `${(micro.jumpRisk01 * 100).toFixed(0)}% · max ${micro.maxBucketJumpCents.toFixed(1)}¢/bucket${micro.whipsawLeader ? ' · whipsaw' : ''}`,
    });
    evidence.push({
      k: 'Micro (takeover)',
      v: `${micro.takeoverRisk.toUpperCase()} · slopes ${micro.slopeCentsUp.toFixed(2)} / ${micro.slopeCentsDown.toFixed(2)} ¢/bk · leader ${micro.leaderLane}`,
    });
  }

  let edge = 5;
  const edgeReasonLines: string[] = [];

  if (gapU?.active) {
    edge += 2.2;
    edgeReasonLines.push('+ active Up gap');
  } else if (gapU) {
    edge += 0.7;
    edgeReasonLines.push('· inactive Up gap');
  }
  if (gapD?.active) {
    edge += 2.2;
    edgeReasonLines.push('+ active Down gap');
  } else if (gapD) {
    edge += 0.7;
    edgeReasonLines.push('· inactive Down gap');
  }
  if (pathUpActive || pathDnActive) {
    edge += 1.2;
    edgeReasonLines.push('+ vacuum lane');
  }
  if (speedLabel === 'FAST') {
    edge += 1.4;
    edgeReasonLines.push('+ fast tape');
  } else if (speedLabel === 'MED') {
    edge += 0.45;
  } else {
    edge -= 1.1;
    edgeReasonLines.push('– slow tape');
  }
  if (upRising || dnRising) edge += 0.6;
  else edge -= 0.35;

  if (overUp && lastU > 0.55) {
    edge -= 1.6;
    edgeReasonLines.push('– Up overextended vs PTB');
  }
  if (overDn && lastD > 0.55) {
    edge -= 1.6;
    edgeReasonLines.push('– Down overextended vs PTB');
  }
  if (gapU?.exitWall != null && wallNear(lastU, gapU.exitWall, 'above')) {
    edge -= 1.9;
    edgeReasonLines.push('– Up: wall close overhead');
  }
  if (gapD?.exitWall != null && wallNear(lastD, gapD.exitWall, 'below')) {
    edge -= 1.9;
    edgeReasonLines.push('– Down: wall close underfoot');
  }

  if (micro) {
    edge -= micro.jumpRisk01 * 2.15;
    if (micro.jumpRisk01 >= 0.42) edgeReasonLines.push('– jumpy path (large bucket moves)');
    if (micro.takeoverRisk === 'high') {
      edge -= 2.45;
      edgeReasonLines.push('– opposing leg taking slope');
    } else if (micro.takeoverRisk === 'med') {
      edge -= 1.05;
      edgeReasonLines.push('– other side catching up');
    }
    if (micro.bothLegsChaotic) {
      edge -= 1.85;
      edgeReasonLines.push('– both legs spiked');
    }
    if (micro.whipsawLeader && micro.jumpRisk01 >= 0.32) {
      edge -= 1.05;
      edgeReasonLines.push('– whipsaw on leader');
    }
    if (micro.spreadNarrowing) {
      edge -= 0.55;
      edgeReasonLines.push('– spread compressing');
    }
  }

  edge = Math.round(clamp(edge, 0, 10) * 10) / 10;

  const hasActiveGap = !!(gapU?.active || gapD?.active);
  const hasAnyGap = !!(gapU || gapD);

  let verdict: SystemVerdict = 'WAIT';
  if (edge >= 7.1 && hasActiveGap && speedLabel !== 'SLOW') verdict = 'ENTER';
  else if ((edge >= 4.8 && edge < 7.1 && hasAnyGap) || (hasActiveGap && (overUp || overDn))) verdict = 'SCALP';
  else verdict = 'WAIT';

  let enterBlockReason: EnterBlockReason = null;
  const gapScoreU = gapU ? gapU.strength10 + (gapU.active ? 0.8 : 0) : 0;
  const gapScoreD = gapD ? gapD.strength10 + (gapD.active ? 0.8 : 0) : 0;
  const bothCompetitive =
    gapU &&
    gapD &&
    ((gapU.active && gapD.active) ||
      (Math.abs(gapScoreU - gapScoreD) <= 1.5 && gapScoreU >= 1.8 && gapScoreD >= 1.8));
  if (bothCompetitive && verdict === 'ENTER') {
    verdict = 'WAIT';
    enterBlockReason = 'dual_lane_tight';
  }

  if (micro && verdict === 'ENTER') {
    if (micro.takeoverRisk === 'high' && speedLabel !== 'FAST') verdict = 'SCALP';
    else if (micro.takeoverRisk === 'high' && micro.jumpRisk01 >= 0.48) verdict = 'SCALP';
    else if (micro.bothLegsChaotic && speedLabel !== 'FAST') verdict = 'SCALP';
    else if (micro.jumpRisk01 >= 0.72) verdict = 'SCALP';
    else if (micro.whipsawLeader && micro.takeoverRisk !== 'low' && speedLabel === 'SLOW') verdict = 'WAIT';
  }
  if (micro && verdict !== 'WAIT') {
    if (micro.takeoverRisk === 'high' && speedLabel === 'SLOW' && micro.jumpRisk01 >= 0.38) verdict = 'WAIT';
  }

  const whyLines: string[] = [
    `PTB distance (Up mid): ${distAbovePp >= 0 ? '+' : ''}${distAbovePp.toFixed(1)}¢ → ${overUp ? 'overextended vs 50¢' : 'not extreme'}`,
    `PTB distance (Down mid): ${distBelowPp >= 0 ? '+' : ''}${distBelowPp.toFixed(1)}¢ → ${overDn ? 'overextended vs 50¢' : 'not extreme'}`,
    `Tape speed: ${speedLabel} (${(speedScore01 * 100).toFixed(0)}%)`,
    `Gaps: Up ${gapUpTxt} · Down ${gapDnTxt}`,
    `Liquidity: Up ${liqU} · Down ${liqD}`,
  ];
  if (micro) {
    whyLines.push(
      `Microstructure: jump risk ${(micro.jumpRisk01 * 100).toFixed(0)}% · takeover ${micro.takeoverRisk} · spread ${micro.spreadNarrowing ? 'compressing' : 'stable'}`,
    );
    for (const s of micro.summaryLines.slice(0, 3)) whyLines.push(s);
  }

  let finalLine = '';
  if (verdict === 'ENTER') {
    finalLine = `YES — gap + flow aligned → fast repricing toward next wall is plausible (edge ${edge.toFixed(1)}/10).`;
  } else if (verdict === 'SCALP') {
    finalLine = `⚠ SCALP ONLY — conditions mixed (overextension, thin follow-through, or walls close). Edge ${edge.toFixed(1)}/10.`;
  } else {
    finalLine = `NO TRADE — low follow-through probability (edge ${edge.toFixed(1)}/10). Wait for active gap + faster tape.`;
  }
  if (micro && micro.takeoverRisk === 'high' && verdict !== 'ENTER') {
    finalLine += ` · Opposing leg is gaining slope — don’t anticipate; wait for your break + tape.`;
  } else if (micro && micro.jumpRisk01 >= 0.55 && verdict === 'SCALP') {
    finalLine += ` · Path is jumpy — size down or use limits.`;
  }

  const enterIf: string[] = [
    'Vacuum/gap turns active (body + continuation on that outcome)',
    'Tape speed not SLOW (momentum returns)',
    'Price does not reject immediately into nearest wall',
  ];
  if (micro && micro.takeoverRisk !== 'low') {
    enterIf.unshift('Short-window slope still favors your lane vs the other leg (or tape confirms the break)');
  }
  if (micro && micro.jumpRisk01 >= 0.42) {
    enterIf.unshift('No chase entries right after a huge single-bucket jump — prefer limits / half size');
  }

  const invalidation: string[] = [
    `Up mid loses structure vs prior bucket (break below recent mini-support in Up panel)`,
    `Down mid loses structure vs prior bucket (same, Down panel)`,
    `Tape stalls SLOW while wall is within ~4¢`,
  ];
  if (micro?.takeoverRisk === 'high') {
    invalidation.push('Opposing outcome prints stronger bucket slope + active structure before your fill');
  }
  if (micro?.bothLegsChaotic) {
    invalidation.push('Another simultaneous violent move on both legs (reset / event risk)');
  }
  if (micro?.spreadNarrowing && micro.takeoverRisk !== 'low') {
    invalidation.push('Up/Down spread keeps compressing against your thesis');
  }

  let highlightGap: 'up' | 'down' | null = null;
  const gapScore = (g: Exclude<GapLite, null>) => g.strength10 + (g.active ? 0.8 : 0);
  if (gapU && gapD) {
    const su = gapScore(gapU);
    const sd = gapScore(gapD);
    if (Math.abs(su - sd) > 0.08) highlightGap = su > sd ? 'up' : 'down';
    else highlightGap = null;
  }
  else if (gapU) highlightGap = 'up';
  else if (gapD) highlightGap = 'down';
  else if (pathUpActive && pathDnActive) highlightGap = lastU >= lastD ? 'up' : 'down';
  else if (pathUpActive) highlightGap = 'up';
  else if (pathDnActive) highlightGap = 'down';

  let highlightWallProb: number | null = null;
  if (highlightGap === 'up') highlightWallProb = gapU?.exitWall ?? null;
  else if (highlightGap === 'down') highlightWallProb = gapD?.exitWall ?? null;

  const conditionalNote =
    lastU > lastD + 0.04
      ? 'If tape re-accelerates → Up lane can still squeeze first.'
      : lastD > lastU + 0.04
        ? 'If tape re-accelerates → Down lane can still squeeze first.'
        : 'If a side breaks with body + follow-through, it can own the next tick of repricing.';

  const regimeSubtitle =
    'Regime = edge + gaps + tape + microstructure (bucket jumps, opposing-leg slope, spread). Gate = break + FAST tape.';

  let balanceNote: string | null = null;
  if (gapU && gapD) {
    const su = gapU.strength10 + (gapU.active ? 0.8 : 0);
    const sd = gapD.strength10 + (gapD.active ? 0.8 : 0);
    if (gapU.active && gapD.active) {
      balanceNote = 'Two-sided: both gaps active — do not size only off the higher mid; wait for your lane’s break + tape.';
    } else if (Math.abs(su - sd) <= 1.5 && (gapU.active || gapD.active || su >= 2 || sd >= 2)) {
      balanceNote = 'Two-sided: gap scores are close — check both ENTER lines before defaulting to momentum.';
    }
  }
  if (micro?.takeoverRisk === 'high' && !balanceNote) {
    balanceNote = 'Opposing side is gaining on short-window slope — confirmation beats anticipation.';
  }

  return {
    state: 'NEUTRAL',
    verdict,
    enterBlockReason,
    edgeScore: edge,
    edgeReasonLines,
    evidence,
    whyLines,
    finalLine,
    enterIf,
    invalidation,
    conditionalNote,
    highlightGap,
    highlightWallProb,
    regimeSubtitle,
    balanceNote,
    tapeSpeedLabel: speedLabel,
    tapeSpeedScore01: speedScore01,
    pathUpActive: pathUpActive,
    pathDnActive: pathDnActive,
    microstructure: micro,
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** When chart model is not ready (no snapshots yet). */
export const PTB_DECISION_FALLBACK: PtbSystemDecision = {
  state: 'NEUTRAL',
  verdict: 'WAIT',
  enterBlockReason: null,
  edgeScore: 0,
  edgeReasonLines: [],
  evidence: [{ k: 'Data', v: 'need mid history on both outcomes' }],
  whyLines: ['Book polling must be ON to score edge.'],
  finalLine: 'NO TRADE — insufficient data to evaluate conditions.',
  enterIf: ['Turn on Book tab polling', 'Wait for two-sided mid history'],
  invalidation: ['—'],
  conditionalNote: null,
  highlightGap: null,
  highlightWallProb: null,
  regimeSubtitle: 'Regime = edge + gaps + tape score. Chart “execution gate” = your break + FAST tape line.',
  balanceNote: null,
  tapeSpeedLabel: 'SLOW',
  tapeSpeedScore01: 0,
  pathUpActive: false,
  pathDnActive: false,
  microstructure: null,
};
