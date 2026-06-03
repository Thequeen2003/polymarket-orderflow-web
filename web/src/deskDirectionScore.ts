/**
 * Four-point direction score from shared desk speeds — scannable UP/DOWN bias.
 */

import type { DeskSpeedSnapshot, LayerSpeed } from './deskSpeedLayers';
import { gapDetailWithGain, probSpeedDetailWithGain, spotSpeedDetailWithGain } from './deskSpeedGainPct';

export type DirectionScoreRow = {
  id: 'spot' | 'ptb' | 'upProb' | 'downProb';
  label: string;
  point: 0 | 1;
  detail: string;
  gainPct: string | null;
  /** One-line trading translation when point = 1. */
  hitLine: string;
  /** One-line when point = 0 (optional context). */
  missLine: string;
};

export type DirectionScoreVerdict =
  | 'STRONG_UP'
  | 'UP'
  | 'NEUTRAL'
  | 'WEAK_UP'
  | 'NO_TRADE'
  | 'WEAK_DOWN'
  | 'DOWN'
  | 'STRONG_DOWN';

export type DirectionScoreSide = {
  bias: 'UP' | 'DOWN';
  score: number;
  max: number;
  rows: DirectionScoreRow[];
  bullets: string[];
};

export type DirectionScoreSnapshot = {
  horizonSec: number;
  up: DirectionScoreSide;
  down: DirectionScoreSide;
  /** Winning side by score; ties → NEUTRAL. */
  bias: 'UP' | 'DOWN' | 'NEUTRAL';
  verdict: DirectionScoreVerdict;
  headline: string;
  emoji: string;
  scoreLine: string;
  /** Active-side rows for the compact card. */
  activeRows: DirectionScoreRow[];
  activeBullets: string[];
};

function verdictForSide(bias: 'UP' | 'DOWN', score: number): DirectionScoreVerdict {
  if (bias === 'UP') {
    if (score >= 4) return 'STRONG_UP';
    if (score === 3) return 'UP';
    if (score === 2) return 'NEUTRAL';
    if (score === 1) return 'WEAK_UP';
    return 'NO_TRADE';
  }
  if (score >= 4) return 'STRONG_DOWN';
  if (score === 3) return 'DOWN';
  if (score === 2) return 'NEUTRAL';
  if (score === 1) return 'WEAK_DOWN';
  return 'NO_TRADE';
}

function headlineForVerdict(v: DirectionScoreVerdict): { headline: string; emoji: string } {
  switch (v) {
    case 'STRONG_UP':
      return { headline: 'STRONG UP', emoji: '🟢' };
    case 'UP':
      return { headline: 'UP', emoji: '🟢' };
    case 'WEAK_UP':
      return { headline: 'WEAK UP', emoji: '🟡' };
    case 'STRONG_DOWN':
      return { headline: 'STRONG DOWN', emoji: '🔴' };
    case 'DOWN':
      return { headline: 'DOWN', emoji: '🔴' };
    case 'WEAK_DOWN':
      return { headline: 'WEAK DOWN', emoji: '🟡' };
    case 'NEUTRAL':
      return { headline: 'NEUTRAL', emoji: '⚪' };
    case 'NO_TRADE':
      return { headline: 'NO TRADE', emoji: '⚫' };
  }
}

function spotRowForUp(spot: LayerSpeed | null, nowSpot: number, horizonSec: number): DirectionScoreRow {
  const up = spot?.direction === 'UP';
  const d = spot ? spotSpeedDetailWithGain(spot, nowSpot, horizonSec) : null;
  return {
    id: 'spot',
    label: 'Spot Speed Up',
    point: up ? 1 : 0,
    detail: d?.detail ?? '—',
    gainPct: d?.gainPct ?? null,
    hitLine: 'Spot accelerating higher',
    missLine:
      spot?.direction === 'DOWN'
        ? 'Spot moving down'
        : spot?.direction === 'FLAT'
          ? 'Spot flat'
          : 'Spot unavailable',
  };
}

function spotRowForDown(spot: LayerSpeed | null, nowSpot: number, horizonSec: number): DirectionScoreRow {
  const down = spot?.direction === 'DOWN';
  const d = spot ? spotSpeedDetailWithGain(spot, nowSpot, horizonSec) : null;
  return {
    id: 'spot',
    label: 'Spot Speed Down',
    point: down ? 1 : 0,
    detail: d?.detail ?? '—',
    gainPct: d?.gainPct ?? null,
    hitLine: 'Spot accelerating lower',
    missLine:
      spot?.direction === 'UP'
        ? 'Spot moving up'
        : spot?.direction === 'FLAT'
          ? 'Spot flat'
          : 'Spot unavailable',
  };
}

function ptbRowForUp(ptb: LayerSpeed | null, speed: DeskSpeedSnapshot, nowSpot: number): DirectionScoreRow {
  const toward = ptb?.ptbGapMotion === 'TOWARD_PTB';
  const d = ptb ? gapDetailWithGain(ptb, speed, nowSpot) : null;
  return {
    id: 'ptb',
    label: 'Gap Closing Toward PTB',
    point: toward ? 1 : 0,
    detail: d?.detail ?? '—',
    gainPct: d?.gainPct ?? null,
    hitLine: 'Reverting toward PTB',
    missLine:
      ptb?.ptbGapMotion === 'AWAY_PTB'
        ? 'Trending away from PTB'
        : ptb?.ptbGapMotion === 'FLAT'
          ? 'PTB gap flat'
          : 'PTB gap unavailable',
  };
}

function ptbRowForDown(
  ptb: LayerSpeed | null,
  gapNowUsd: number | null,
  speed: DeskSpeedSnapshot,
  nowSpot: number,
): DirectionScoreRow {
  const toward = ptb?.ptbGapMotion === 'TOWARD_PTB';
  const away = ptb?.ptbGapMotion === 'AWAY_PTB';
  const downRevert =
    toward &&
    gapNowUsd != null &&
    Number.isFinite(gapNowUsd) &&
    gapNowUsd > 0 &&
    (ptb?.direction === 'DOWN' || ptb?.delta30 < 0);
  const downTrend = away && gapNowUsd != null && gapNowUsd < 0;
  const point = downRevert || downTrend ? 1 : 0;
  const d = ptb ? gapDetailWithGain(ptb, speed, nowSpot) : null;
  return {
    id: 'ptb',
    label: toward ? 'Gap Closing Toward PTB' : 'Gap Trending From PTB',
    point: point ? 1 : 0,
    detail: d?.detail ?? '—',
    gainPct: d?.gainPct ?? null,
    hitLine: downRevert ? 'Mean-revert pressure lower' : 'Trending lower from PTB',
    missLine:
      ptb?.ptbGapMotion === 'FLAT'
        ? 'PTB gap flat'
        : toward
          ? 'Revert favors UP, not DOWN'
          : 'No clear DOWN PTB speed',
  };
}

function probUpRow(
  prob: LayerSpeed | null,
  upLabel: string,
  pNow01: number | null,
  horizonSec: number,
): DirectionScoreRow {
  const rising = prob?.direction === 'UP';
  const d = prob ? probSpeedDetailWithGain(prob, pNow01, horizonSec) : null;
  return {
    id: 'upProb',
    label: `${upLabel} Probability Rising`,
    point: rising ? 1 : 0,
    detail: d?.detail ?? '—',
    gainPct: d?.gainPct ?? null,
    hitLine: `${upLabel} probability increasing`,
    missLine:
      prob?.direction === 'DOWN'
        ? `${upLabel} probability decreasing`
        : prob?.direction === 'FLAT'
          ? `${upLabel} mid flat`
          : `${upLabel} mid unavailable`,
  };
}

function probDownRowForUp(
  prob: LayerSpeed | null,
  downLabel: string,
  pNow01: number | null,
  horizonSec: number,
): DirectionScoreRow {
  const falling = prob?.direction === 'DOWN';
  const d = prob ? probSpeedDetailWithGain(prob, pNow01, horizonSec) : null;
  return {
    id: 'downProb',
    label: `${downLabel} Probability Falling`,
    point: falling ? 1 : 0,
    detail: d?.detail ?? '—',
    gainPct: d?.gainPct ?? null,
    hitLine: `${downLabel} probability decreasing`,
    missLine:
      prob?.direction === 'UP'
        ? `${downLabel} probability increasing`
        : prob?.direction === 'FLAT'
          ? `${downLabel} mid flat`
          : `${downLabel} mid unavailable`,
  };
}

function probDownRowForDown(
  prob: LayerSpeed | null,
  downLabel: string,
  pNow01: number | null,
  horizonSec: number,
): DirectionScoreRow {
  const rising = prob?.direction === 'UP';
  const d = prob ? probSpeedDetailWithGain(prob, pNow01, horizonSec) : null;
  return {
    id: 'downProb',
    label: `${downLabel} Probability Rising`,
    point: rising ? 1 : 0,
    detail: d?.detail ?? '—',
    gainPct: d?.gainPct ?? null,
    hitLine: `${downLabel} probability increasing`,
    missLine:
      prob?.direction === 'DOWN'
        ? `${downLabel} probability decreasing`
        : prob?.direction === 'FLAT'
          ? `${downLabel} mid flat`
          : `${downLabel} mid unavailable`,
  };
}

function probUpRowForDown(
  prob: LayerSpeed | null,
  upLabel: string,
  pNow01: number | null,
  horizonSec: number,
): DirectionScoreRow {
  const falling = prob?.direction === 'DOWN';
  const d = prob ? probSpeedDetailWithGain(prob, pNow01, horizonSec) : null;
  return {
    id: 'upProb',
    label: `${upLabel} Probability Falling`,
    point: falling ? 1 : 0,
    detail: d?.detail ?? '—',
    gainPct: d?.gainPct ?? null,
    hitLine: `${upLabel} probability decreasing`,
    missLine:
      prob?.direction === 'UP'
        ? `${upLabel} probability increasing`
        : prob?.direction === 'FLAT'
          ? `${upLabel} mid flat`
          : `${upLabel} mid unavailable`,
  };
}

function buildSide(rows: DirectionScoreRow[], bias: 'UP' | 'DOWN'): DirectionScoreSide {
  const score = rows.reduce((s, r) => s + r.point, 0);
  const bullets = rows.filter((r) => r.point === 1).map((r) => r.hitLine);
  return { bias, score, max: rows.length, rows, bullets };
}

export function computeDirectionScore(
  speed: DeskSpeedSnapshot,
  upLabel = 'UP',
  downLabel = 'DOWN',
  opts?: { nowSpot?: number | null; pMktUp?: number | null; pMktDown?: number | null },
): DirectionScoreSnapshot {
  const spot = speed.spot;
  const ptb = speed.ptbGap;
  const probUp = speed.lanes.up.prob;
  const probDown = speed.lanes.down.prob;
  const nowSpot = opts?.nowSpot ?? NaN;
  const h = speed.horizonSec;

  const up = buildSide(
    [
      spotRowForUp(spot, nowSpot, h),
      ptbRowForUp(ptb, speed, nowSpot),
      probUpRow(probUp, upLabel, opts?.pMktUp ?? null, h),
      probDownRowForUp(probDown, downLabel, opts?.pMktDown ?? null, h),
    ],
    'UP',
  );

  const down = buildSide(
    [
      spotRowForDown(spot, nowSpot, h),
      ptbRowForDown(ptb, speed.gapNowUsd, speed, nowSpot),
      probDownRowForDown(probDown, downLabel, opts?.pMktDown ?? null, h),
      probUpRowForDown(probUp, upLabel, opts?.pMktUp ?? null, h),
    ],
    'DOWN',
  );

  let bias: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
  if (up.score > down.score) bias = 'UP';
  else if (down.score > up.score) bias = 'DOWN';

  const active = bias === 'DOWN' ? down : up;
  const verdict =
    bias === 'NEUTRAL'
      ? up.score === 0 && down.score === 0
        ? 'NO_TRADE'
        : 'NEUTRAL'
      : verdictForSide(bias, active.score);
  const { headline, emoji } = headlineForVerdict(verdict);

  return {
    horizonSec: speed.horizonSec,
    up,
    down,
    bias,
    verdict,
    headline,
    emoji,
    scoreLine: `${active.score}/${active.max}`,
    activeRows: active.rows,
    activeBullets: active.bullets,
  };
}

export function directionScoreShortLabel(snap: DirectionScoreSnapshot): string {
  return `${snap.emoji} ${snap.headline} · ${snap.scoreLine}`;
}
