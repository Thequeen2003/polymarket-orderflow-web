import type { BookSnapshot } from './orderflowMetrics';
import type { BookLevel } from './bookLevels';
import type { AlertEvent, AlertKind, AlertPrefs, EntryVerdict, TradePlan } from './momentumAlertsTypes';

function parseNum(s: string): number | null {
  const n = Number(String(s).trim().replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function linearSlopePerSec(pts: { t: number; v: number }[]): number | null {
  if (pts.length < 3) return null;
  const n = pts.length;
  let sumT = 0;
  let sumV = 0;
  for (const p of pts) {
    sumT += p.t;
    sumV += p.v;
  }
  const meanT = sumT / n;
  const meanV = sumV / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    const dt = (p.t - meanT) / 1000;
    num += dt * (p.v - meanV);
    den += dt * dt;
  }
  if (den < 1e-12) return null;
  return num / den;
}

function avgSize(levels: BookLevel[], from: number, count: number): number {
  let s = 0;
  let c = 0;
  for (let i = from; i < Math.min(levels.length, from + count); i++) {
    s += levels[i]!.size;
    c++;
  }
  return c > 0 ? s / c : 0;
}

export type WallInfo = {
  bidWall: boolean;
  askWall: boolean;
  bidRatio: number;
  askRatio: number;
};

export function detectWalls(levels: { bids: BookLevel[]; asks: BookLevel[] }, ratio = 2.2): WallInfo {
  const bb = levels.bids[0]?.size ?? 0;
  const ba = levels.asks[0]?.size ?? 0;
  const bidAvg = avgSize(levels.bids, 1, 4);
  const askAvg = avgSize(levels.asks, 1, 4);
  const bidRatio = bidAvg > 0 ? bb / bidAvg : 0;
  const askRatio = askAvg > 0 ? ba / askAvg : 0;
  return {
    bidWall: bb > 0 && bidRatio >= ratio,
    askWall: ba > 0 && askRatio >= ratio,
    bidRatio,
    askRatio,
  };
}

/** Thin liquidity above mid: sum of sizes in first 3 ask levels vs next 5. */
export function thinLiquidityAbove(asks: BookLevel[]): { thinScore: number; note: string } {
  if (asks.length < 4) return { thinScore: 0, note: 'Not enough ask depth.' };
  const top3 = asks.slice(0, 3).reduce((s, l) => s + l.size, 0);
  const next5 = asks.slice(3, 8).reduce((s, l) => s + l.size, 0);
  const denom = top3 + next5;
  const thinScore = denom > 0 ? next5 / denom : 0;
  const note =
    thinScore < 0.35
      ? 'Top of book holds most of the liquidity; a wall or thick band may be close.'
      : 'Liquidity is more spread out above mid.';
  return { thinScore, note };
}

export function firstNotableWallAbove(asks: BookLevel[], mid: number, mult = 2.5): { price: number; size: number } | null {
  const base = avgSize(asks, 0, Math.min(5, asks.length));
  if (!(base > 0)) return null;
  for (const l of asks) {
    if (l.price >= mid && l.size >= base * mult) return { price: l.price, size: l.size };
  }
  return null;
}

export type TickEvalInput = {
  slug: string;
  t: number;
  mid: number | null;
  snap: BookSnapshot;
  bestBidSize: number;
  bestAskSize: number;
  wall: WallInfo;
  mids: { t: number; v: number }[];
  snaps: BookSnapshot[];
  prevBestBid: number | null;
  prevBestAsk: number | null;
  prevSlope: number | null;
  plan: TradePlan;
  prefs: AlertPrefs;
  momentumThreshold: number;
};

let alertSeq = 0;
function ev(slug: string, kind: AlertKind, message: string): AlertEvent {
  alertSeq += 1;
  return { id: `a-${alertSeq}-${Math.random().toString(36).slice(2, 8)}`, t: Date.now(), slug, kind, message };
}

export function evaluateTick(input: TickEvalInput): AlertEvent[] {
  const out: AlertEvent[] = [];
  const { slug, prefs, plan, mids, snaps, wall } = input;

  const slope = linearSlopePerSec(mids.slice(-30));
  const slopeTh = input.momentumThreshold;

  if (prefs.momentum_start && input.prevSlope != null && slope != null) {
    if (input.prevSlope < slopeTh && slope >= slopeTh * 1.2) {
      out.push(ev(slug, 'momentum_start', `Strong momentum starting (${slope.toFixed(5)}/s vs threshold ${slopeTh}).`));
    }
  }
  if (prefs.momentum_slow && input.prevSlope != null && slope != null) {
    if (input.prevSlope > slopeTh * 1.2 && slope < slopeTh * 0.5) {
      out.push(ev(slug, 'momentum_slow', `Momentum slowing (slope ${slope.toFixed(5)}/s).`));
    }
  }

  if (prefs.bid_wall && wall.bidWall) {
    out.push(ev(slug, 'bid_wall', `Bid wall: best bid size ${wall.bidRatio.toFixed(1)}× deeper levels.`));
  }
  if (prefs.ask_wall && wall.askWall) {
    out.push(ev(slug, 'ask_wall', `Ask wall: best ask size ${wall.askRatio.toFixed(1)}× deeper levels.`));
  }

  if (prefs.bids_pulled && input.prevBestBid != null && input.bestBidSize > 0) {
    const drop = (input.prevBestBid - input.bestBidSize) / input.prevBestBid;
    if (drop > 0.45) out.push(ev(slug, 'bids_pulled', `Bids pulled: best bid size dropped ~${Math.round(drop * 100)}%.`));
  }

  if (prefs.asks_eaten && input.prevBestAsk != null && input.bestAskSize > 0) {
    const drop = (input.prevBestAsk - input.bestAskSize) / input.prevBestAsk;
    if (drop > 0.35 && slope != null && slope > 0) {
      out.push(ev(slug, 'asks_eaten', `Asks being eaten: top ask size down ~${Math.round(drop * 100)}% while mid rising.`));
    }
  }

  if (prefs.spoof_suspect && input.prevBestBid != null && input.bestBidSize > 0) {
    const drop = (input.prevBestBid - input.bestBidSize) / input.prevBestBid;
    if (drop > 0.65 && (slope == null || Math.abs(slope) < slopeTh * 0.5)) {
      out.push(ev(slug, 'spoof_suspect', `Large bid disappeared without price follow-through — possible spoof.`));
    }
  }

  const entry = parseNum(plan.plannedEntry);
  const entryLo = parseNum(plan.entryRangeLow);
  const entryHi = parseNum(plan.entryRangeHigh);
  const target = parseNum(plan.targetSell);
  const mid = input.mid;

  if (prefs.near_entry && mid != null && entry != null) {
    if (Math.abs(mid - entry) < 0.012) {
      out.push(ev(slug, 'near_entry', `Price near planned entry (${mid.toFixed(4)} vs ${entry}).`));
    }
  }
  if (prefs.near_entry && mid != null && entryLo != null && entryHi != null && entryHi >= entryLo) {
    if (mid >= entryLo && mid <= entryHi) {
      out.push(ev(slug, 'near_entry', `Inside ideal entry range [${entryLo}, ${entryHi}].`));
    }
  }
  if (prefs.near_target && mid != null && target != null) {
    if (Math.abs(mid - target) < 0.015) {
      out.push(ev(slug, 'near_target', `Near take-profit zone (~${target}).`));
    }
  }

  if (prefs.weak_follow && snaps.length >= 8) {
    const recent = snaps.slice(-8);
    const imb = recent.map((s) => s.imbalance).filter((x): x is number => x != null);
    const lastImb = imb[imb.length - 1];
    const midsRecent = mids.slice(-6);
    if (lastImb != null && Math.abs(lastImb) > 0.25 && midsRecent.length >= 4) {
      const d = Math.abs(midsRecent[midsRecent.length - 1]!.v - midsRecent[0]!.v);
      if (d < 0.004) {
        out.push(ev(slug, 'weak_follow', `Weak follow-through: imbalance was directional but mid barely moved.`));
      }
    }
  }

  if (prefs.do_not_enter_signal && plan.doNotEnter.trim()) {
    const bad =
      (wall.askWall && slope != null && slope < 0) ||
      (slope != null && slope < -slopeTh * 2) ||
      (snaps.length > 0 && snaps[snaps.length - 1]!.spread != null && snaps[snaps.length - 1]!.spread! > 0.05);
    if (bad) {
      out.push(
        ev(slug, 'do_not_enter_signal', `Conditions match “do not enter” / low-quality: check spread, walls, and slope.`),
      );
    }
  }

  return out;
}

export function buildEntryVerdict(params: {
  mid: number | null;
  slope: number | null;
  snap: BookSnapshot;
  wall: WallInfo;
  asks: BookLevel[];
  plan: TradePlan;
  momentumThreshold: number;
}): EntryVerdict {
  const { mid, slope, snap, wall, asks, plan, momentumThreshold } = params;
  const bullets: string[] = [];
  let tone: EntryVerdict['tone'] = 'neutral';
  let headline = 'Gathering context…';

  if (mid == null) {
    return { headline: 'No mid yet — wait for book.', tone: 'wait', bullets: ['Need bid+ask or one-sided book.'] };
  }

  bullets.push(
    'Charts here use mid (bid/ask average). Your first buy still lifts the ask; your first sell still hits the bid — use the ladder to see those exact levels.',
  );

  const slopeTh = momentumThreshold;
  const slopeReal = slope != null && Math.abs(slope) >= slopeTh;
  if (slopeReal) {
    bullets.push(`Momentum looks ${slope! > 0 ? 'positive' : 'negative'} (${slope!.toFixed(5)}/s).`);
    if (slope! > 0) tone = 'good';
  } else {
    bullets.push(`Momentum is muted vs your threshold (${slopeTh}).`);
    tone = 'wait';
  }

  if (snap.imbalance != null) {
    const b = snap.imbalance;
    bullets.push(
      `Depth imbalance: ${b > 0.08 ? 'more bid depth' : b < -0.08 ? 'more ask depth' : 'balanced'} (${(b * 100).toFixed(0)}%).`,
    );
  }

  const thin = thinLiquidityAbove(asks);
  bullets.push(thin.note);

  const wallUp = firstNotableWallAbove(asks, mid);
  if (wallUp) {
    bullets.push(`First notable ask wall near ${wallUp.price.toFixed(4)} (size ${wallUp.size.toFixed(0)}).`);
  }

  if (wall.askWall) {
    bullets.push('Ask wall at touch — lifting may be harder; avoid chasing into it.');
    if (tone === 'good') tone = 'wait';
  }
  if (wall.bidWall) {
    bullets.push('Bid wall at touch — support may be real if it holds.');
  }

  const entry = parseNum(plan.plannedEntry);
  const target = parseNum(plan.targetSell);
  if (entry != null) {
    const dist = mid - entry;
    bullets.push(
      `Mid vs planned entry: ${dist > 0.01 ? 'above' : dist < -0.01 ? 'below' : 'at'} entry (${mid.toFixed(4)} vs ${entry}).`,
    );
  }
  if (target != null && entry != null) {
    if (mid >= target - 0.01) tone = 'good';
    bullets.push(`Target: ${target} — ${mid >= target - 0.01 ? 'approaching or past take-profit zone' : 'still away from target'}.`);
  }

  if (plan.doNotEnter.trim().length > 0) {
    bullets.push(`Your “do not enter” notes are on file — ${plan.doNotEnter.length > 80 ? plan.doNotEnter.slice(0, 80) + '…' : plan.doNotEnter}`);
  }

  if (snap.spread != null && snap.spread > 0.04) {
    headline = 'Wide spread — low-quality read';
    tone = 'bad';
  } else if (tone === 'wait') {
    headline = 'Wait — not ready';
  } else if (wall.askWall && slope != null && slope < slopeTh) {
    headline = 'Ask wall above — be careful';
    tone = 'wait';
  } else if (slopeReal && !wall.askWall) {
    headline = 'Good entry forming';
  } else {
    headline = 'Mixed — use alerts + book';
  }

  return { headline, tone, bullets: bullets.slice(0, 9) };
}

export function parseMomentumThreshold(plan: TradePlan): number {
  const n = parseNum(plan.momentumThreshold);
  if (n != null && n > 0) return n;
  return 0.015;
}
