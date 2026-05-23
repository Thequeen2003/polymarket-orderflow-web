/**
 * Per-outcome CLOB wall read — matches ladder UI ("wall ask" / "wall bid").
 * **Wall ask** drives flow (resistance / winning side).
 * **Wall bid** is warning-only (thick support — don't chase through it).
 */

import { pickBookLevels } from './bookLevels';
import { detectWalls, type WallInfo } from './entryDecisionEngine';

const LADDER_DEPTH = 12;

export type OutcomeWallSnapshot = {
  lane: 'up' | 'down';
  askWall: boolean;
  bidWall: boolean;
  askRatio: number;
  bidRatio: number;
  wallAsk: { price: number; size: number } | null;
  wallBid: { price: number; size: number } | null;
};

export type WallBidWarning = {
  lane: 'up' | 'down';
  text: string;
};

export type DualOutcomeWallFlow = {
  up: OutcomeWallSnapshot | null;
  down: OutcomeWallSnapshot | null;
  flowLane: 'up' | 'down' | null;
  pressure: number;
  headline: string;
  bidWarnings: WallBidWarning[];
};

function maxSizeLevel(levels: { price: number; size: number }[]): { price: number; size: number } | null {
  let best: { price: number; size: number } | null = null;
  for (const l of levels) {
    if (!Number.isFinite(l.size) || l.size <= 0) continue;
    if (!best || l.size > best.size) best = { price: l.price, size: l.size };
  }
  return best;
}

function avgSizeOthers(levels: { price: number; size: number }[], skipPrice: number | null): number {
  const rest = skipPrice == null ? levels : levels.filter((l) => l.price !== skipPrice);
  if (!rest.length) return 0;
  return rest.reduce((s, l) => s + l.size, 0) / rest.length;
}

function fmtWallCents(price: number): string {
  return `${(price * 100).toFixed(1)}¢`;
}

function snapshot(lane: 'up' | 'down', book: unknown): OutcomeWallSnapshot | null {
  const { bids, asks } = pickBookLevels(book);
  if (bids.length === 0 && asks.length === 0) return null;

  const touch: WallInfo = detectWalls({ bids, asks });
  const bidsTop = bids.slice(0, LADDER_DEPTH);
  const asksTop = asks.slice(0, LADDER_DEPTH);
  const wallBid = maxSizeLevel(bidsTop);
  const wallAsk = maxSizeLevel(asksTop);

  const bidAvg = avgSizeOthers(bidsTop, wallBid?.price ?? null);
  const askAvg = avgSizeOthers(asksTop, wallAsk?.price ?? null);
  const bidWall =
    touch.bidWall || (wallBid != null && bidAvg > 0 && wallBid.size >= bidAvg * 1.55);
  const askWall =
    touch.askWall || (wallAsk != null && askAvg > 0 && wallAsk.size >= askAvg * 1.55);

  return {
    lane,
    bidWall,
    askWall,
    bidRatio: touch.bidRatio,
    askRatio: touch.askRatio,
    wallBid,
    wallAsk,
  };
}

/** Flow score from ask walls only (resistance → opposite lane). */
function askWallBoost(w: OutcomeWallSnapshot): number {
  const ratio = w.askRatio;
  let score = 0;
  if (w.askWall) score += Math.min(4.2, ratio * 1.65);
  else if (ratio >= 1.55) score += Math.min(2.2, ratio * 0.75);
  if (w.wallAsk && w.wallAsk.size >= 180) score += Math.min(1.2, w.wallAsk.size / 350);
  return score * 1.18;
}

function wallAskPhrase(label: string, w: OutcomeWallSnapshot): string | null {
  if (!w.askWall && !w.wallAsk) return null;
  const tag = 'wall ask';
  if (w.wallAsk) {
    const mult = w.askWall && w.askRatio >= 1.4 ? ` ${w.askRatio.toFixed(1)}×` : '';
    return `${label} ${tag} ${fmtWallCents(w.wallAsk.price)}${mult}`;
  }
  if (w.askWall) return `${label} ${tag} ${w.askRatio.toFixed(1)}×`;
  return null;
}

function buildBidWallWarnings(
  snap: OutcomeWallSnapshot,
  label: string,
  entryLane: 'up' | 'down' | null | undefined,
): WallBidWarning | null {
  if (!snap.bidWall) return null;
  const px = snap.wallBid ? fmtWallCents(snap.wallBid.price) : '';
  const mult = snap.bidRatio >= 1.4 ? ` ${snap.bidRatio.toFixed(1)}×` : '';
  const base = `${label} wall bid ${px}${mult}`.trim();
  if (entryLane === snap.lane) {
    return {
      lane: snap.lane,
      text: `${base} — support stacked; don't chase the ask · join bid or wait`,
    };
  }
  if (entryLane != null && entryLane !== snap.lane) {
    return {
      lane: snap.lane,
      text: `${base} — opposite book defended; harder to fade ${label}`,
    };
  }
  return {
    lane: snap.lane,
    text: `${base} — thick bid support (warning, not entry fuel)`,
  };
}

/** One combined line for the desk strip / machine card. */
export function formatWallBidWarnings(
  warnings: WallBidWarning[],
  entryLane?: 'up' | 'down' | null,
): string | null {
  if (!warnings.length) return null;
  const prioritized = entryLane
    ? [
        ...warnings.filter((w) => w.lane === entryLane),
        ...warnings.filter((w) => w.lane !== entryLane),
      ]
    : warnings;
  const text = prioritized.map((w) => w.text).join(' · ');
  return text.length > 168 ? `${text.slice(0, 167)}…` : text;
}

/**
 * Ask walls pick flow lane; bid walls emit warnings only.
 */
export function computeDualOutcomeWallFlow(args: {
  upBook: unknown | null | undefined;
  downBook: unknown | null | undefined;
  upLabel?: string;
  downLabel?: string;
  /** When set, bid-wall copy references the intended entry lane. */
  entryLane?: 'up' | 'down' | null;
}): DualOutcomeWallFlow | null {
  const up = args.upBook != null ? snapshot('up', args.upBook) : null;
  const down = args.downBook != null ? snapshot('down', args.downBook) : null;
  if (!up && !down) return null;

  const upLabel = args.upLabel ?? 'UP';
  const downLabel = args.downLabel ?? 'DOWN';
  let upScore = 0;
  let downScore = 0;

  if (up) downScore += askWallBoost(up);
  if (down) upScore += askWallBoost(down);

  const pressure = upScore - downScore;
  const margin = 0.42;
  let flowLane: 'up' | 'down' | null = null;
  if (upScore >= downScore + margin) flowLane = 'up';
  else if (downScore >= upScore + margin) flowLane = 'down';

  const parts: string[] = [];
  if (up) {
    const p = wallAskPhrase(upLabel, up);
    if (p) parts.push(p);
  }
  if (down) {
    const p = wallAskPhrase(downLabel, down);
    if (p) parts.push(p);
  }

  const bidWarnings: WallBidWarning[] = [];
  if (up) {
    const w = buildBidWallWarnings(up, upLabel, args.entryLane);
    if (w) bidWarnings.push(w);
  }
  if (down) {
    const w = buildBidWallWarnings(down, downLabel, args.entryLane);
    if (w) bidWarnings.push(w);
  }

  const headline =
    flowLane != null
      ? `Walls → ${flowLane === 'up' ? upLabel : downLabel}${parts.length ? ` (${parts.join(' · ')})` : ''}`
      : parts.length
        ? `Wall ask mixed (${parts.join(' · ')})`
        : bidWarnings.length
          ? 'Wall bid warnings — ask side flat'
          : 'Walls flat at touch';

  return { up, down, flowLane, pressure, headline, bidWarnings };
}
