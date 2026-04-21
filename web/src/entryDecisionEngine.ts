import type { BookSnapshot } from './orderflowMetrics';
import type { BookLevel } from './bookLevels';
import type {
  AlertEvent,
  AlertKind,
  AlertPrefs,
  AlertSeverity,
  EntryVerdict,
  ScalpVerdict,
  ScalpVerdictRow,
  TradePlan,
  UpScalpSettings,
} from './momentumAlertsTypes';
import type { Net4cEstimate } from './executionEstimator';
import { clamp100, confidenceLabel, fmtSigned, type SignalDriver, type SignalFlag } from './signalPayload';

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
function ev(
  slug: string,
  kind: AlertKind,
  message: string,
  extras?: {
    severity?: AlertSeverity;
    confidenceScore?: number;
    flags?: SignalFlag[];
    drivers?: SignalDriver[];
  },
): AlertEvent {
  alertSeq += 1;
  return {
    id: `a-${alertSeq}-${Math.random().toString(36).slice(2, 8)}`,
    t: Date.now(),
    slug,
    kind,
    message,
    severity: extras?.severity,
    confidenceScore: extras?.confidenceScore,
    flags: extras?.flags,
    drivers: extras?.drivers,
  };
}

export function evaluateTick(input: TickEvalInput): AlertEvent[] {
  const out: AlertEvent[] = [];
  const { slug, prefs, plan, mids, snaps, wall } = input;

  const slope = linearSlopePerSec(mids.slice(-30));
  const slopeTh = input.momentumThreshold;

  const flags: SignalFlag[] = [];
  const drivers: SignalDriver[] = [];

  const spread = input.snap.spread ?? null;
  const churn = input.snap.churn ?? null;
  if (spread != null && spread > 0.06) flags.push({ id: 'WideSpreads', label: `Wide spread (${(spread * 100).toFixed(1)}¢)`, severity: 'warn' });
  if (spread != null && spread > 0.12) flags.push({ id: 'VeryWideSpreads', label: 'Very wide spread', severity: 'warn' });
  if (churn != null && churn >= 800) flags.push({ id: 'Churny', label: `Churny quotes (${churn.toFixed(0)})`, severity: 'warn' });

  drivers.push({ key: 'mid', label: 'Mid', value: input.mid == null ? '—' : input.mid.toFixed(4), raw: input.mid ?? undefined });
  drivers.push({ key: 'slope', label: 'Slope', value: slope == null ? '—' : `${slope >= 0 ? '+' : ''}${slope.toFixed(5)}/s`, raw: slope ?? undefined });
  drivers.push({ key: 'slopeTh', label: 'Slope threshold', value: `${slopeTh.toFixed(5)}/s`, raw: slopeTh });
  drivers.push({ key: 'spread', label: 'Spread', value: spread == null ? '—' : `${(spread * 100).toFixed(1)}¢`, raw: spread ?? undefined });
  drivers.push({ key: 'churn', label: 'Churn', value: churn == null ? '—' : churn.toFixed(0), raw: churn ?? undefined });
  drivers.push({ key: 'wall.bidRatio', label: 'Bid wall ratio', value: wall.bidRatio ? wall.bidRatio.toFixed(2) + '×' : '—', raw: wall.bidRatio });
  drivers.push({ key: 'wall.askRatio', label: 'Ask wall ratio', value: wall.askRatio ? wall.askRatio.toFixed(2) + '×' : '—', raw: wall.askRatio });

  // Deterministic confidence (0–100) for alerts from this tick context.
  let conf = 100;
  if (spread != null) {
    if (spread > 0.12) conf -= 35;
    else if (spread > 0.06) conf -= 18;
    else if (spread > 0.035) conf -= 8;
  }
  if (churn != null && churn >= 800) conf -= 12;
  if (slope == null) conf -= 8;
  conf = clamp100(conf);

  if (prefs.momentum_start && input.prevSlope != null && slope != null) {
    if (input.prevSlope < slopeTh && slope >= slopeTh * 1.2) {
      const sev: AlertSeverity = conf >= 75 ? 'critical' : conf >= 55 ? 'warn' : 'info';
      out.push(
        ev(slug, 'momentum_start', `Strong momentum starting (${slope.toFixed(5)}/s vs threshold ${slopeTh}).`, {
          severity: sev,
          confidenceScore: conf,
          flags,
          drivers: [
            ...drivers,
            { key: 'momentum.delta', label: 'Slope vs threshold', value: `${fmtSigned(slope - slopeTh, 5)}/s`, raw: slope - slopeTh },
            { key: 'confidence', label: 'Confidence', value: `${conf.toFixed(0)}/100 (${confidenceLabel(conf)})`, raw: conf },
          ],
        }),
      );
    }
  }
  if (prefs.momentum_slow && input.prevSlope != null && slope != null) {
    if (input.prevSlope > slopeTh * 1.2 && slope < slopeTh * 0.5) {
      out.push(
        ev(slug, 'momentum_slow', `Momentum slowing (slope ${slope.toFixed(5)}/s).`, {
          severity: conf >= 70 ? 'warn' : 'info',
          confidenceScore: conf,
          flags,
          drivers: [...drivers, { key: 'confidence', label: 'Confidence', value: `${conf.toFixed(0)}/100 (${confidenceLabel(conf)})`, raw: conf }],
        }),
      );
    }
  }

  if (prefs.bid_wall && wall.bidWall) {
    out.push(
      ev(slug, 'bid_wall', `Bid wall: best bid size ${wall.bidRatio.toFixed(1)}× deeper levels.`, {
        severity: conf >= 75 ? 'warn' : 'info',
        confidenceScore: conf,
        flags,
        drivers: [...drivers, { key: 'confidence', label: 'Confidence', value: `${conf.toFixed(0)}/100 (${confidenceLabel(conf)})`, raw: conf }],
      }),
    );
  }
  if (prefs.ask_wall && wall.askWall) {
    out.push(
      ev(slug, 'ask_wall', `Ask wall: best ask size ${wall.askRatio.toFixed(1)}× deeper levels.`, {
        severity: conf >= 75 ? 'warn' : 'info',
        confidenceScore: conf,
        flags,
        drivers: [...drivers, { key: 'confidence', label: 'Confidence', value: `${conf.toFixed(0)}/100 (${confidenceLabel(conf)})`, raw: conf }],
      }),
    );
  }

  if (prefs.bids_pulled && input.prevBestBid != null && input.bestBidSize > 0) {
    const drop = (input.prevBestBid - input.bestBidSize) / input.prevBestBid;
    if (drop > 0.45)
      out.push(
        ev(slug, 'bids_pulled', `Bids pulled: best bid size dropped ~${Math.round(drop * 100)}%.`, {
          severity: conf >= 70 ? 'warn' : 'info',
          confidenceScore: conf,
          flags,
          drivers: [...drivers, { key: 'bestBid.drop', label: 'Best bid drop', value: `${Math.round(drop * 100)}%`, raw: drop }],
        }),
      );
  }

  if (prefs.asks_eaten && input.prevBestAsk != null && input.bestAskSize > 0) {
    const drop = (input.prevBestAsk - input.bestAskSize) / input.prevBestAsk;
    if (drop > 0.35 && slope != null && slope > 0) {
      out.push(
        ev(slug, 'asks_eaten', `Asks being eaten: top ask size down ~${Math.round(drop * 100)}% while mid rising.`, {
          severity: conf >= 75 ? 'warn' : 'info',
          confidenceScore: conf,
          flags,
          drivers: [...drivers, { key: 'bestAsk.drop', label: 'Best ask drop', value: `${Math.round(drop * 100)}%`, raw: drop }],
        }),
      );
    }
  }

  if (prefs.spoof_suspect && input.prevBestBid != null && input.bestBidSize > 0) {
    const drop = (input.prevBestBid - input.bestBidSize) / input.prevBestBid;
    if (drop > 0.65 && (slope == null || Math.abs(slope) < slopeTh * 0.5)) {
      out.push(
        ev(slug, 'spoof_suspect', `Large bid disappeared without price follow-through — possible spoof.`, {
          severity: conf >= 70 ? 'warn' : 'info',
          confidenceScore: conf,
          flags,
          drivers: [...drivers, { key: 'bestBid.drop', label: 'Best bid drop', value: `${Math.round(drop * 100)}%`, raw: drop }],
        }),
      );
    }
  }

  const entry = parseNum(plan.plannedEntry);
  const entryLo = parseNum(plan.entryRangeLow);
  const entryHi = parseNum(plan.entryRangeHigh);
  const target = parseNum(plan.targetSell);
  const mid = input.mid;

  if (prefs.near_entry && mid != null && entry != null) {
    if (Math.abs(mid - entry) < 0.012) {
      out.push(
        ev(slug, 'near_entry', `Price near planned entry (${mid.toFixed(4)} vs ${entry}).`, {
          severity: 'info',
          confidenceScore: conf,
          flags,
          drivers: [...drivers, { key: 'entry', label: 'Planned entry', value: entry.toFixed(4), raw: entry }],
        }),
      );
    }
  }
  if (prefs.near_entry && mid != null && entryLo != null && entryHi != null && entryHi >= entryLo) {
    if (mid >= entryLo && mid <= entryHi) {
      out.push(
        ev(slug, 'near_entry', `Inside ideal entry range [${entryLo}, ${entryHi}].`, {
          severity: 'info',
          confidenceScore: conf,
          flags,
          drivers: [
            ...drivers,
            { key: 'entryLo', label: 'Entry range low', value: entryLo.toFixed(4), raw: entryLo },
            { key: 'entryHi', label: 'Entry range high', value: entryHi.toFixed(4), raw: entryHi },
          ],
        }),
      );
    }
  }
  if (prefs.near_target && mid != null && target != null) {
    if (Math.abs(mid - target) < 0.015) {
      out.push(
        ev(slug, 'near_target', `Near take-profit zone (~${target}).`, {
          severity: conf >= 70 ? 'warn' : 'info',
          confidenceScore: conf,
          flags,
          drivers: [...drivers, { key: 'target', label: 'Target', value: target.toFixed(4), raw: target }],
        }),
      );
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
        out.push(
          ev(slug, 'weak_follow', `Weak follow-through: imbalance was directional but mid barely moved.`, {
            severity: conf >= 70 ? 'warn' : 'info',
            confidenceScore: conf,
            flags,
            drivers: [...drivers, { key: 'mid.delta', label: 'Recent mid move', value: d.toFixed(4), raw: d }],
          }),
        );
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
        ev(slug, 'do_not_enter_signal', `Conditions match “do not enter” / low-quality: check spread, walls, and slope.`, {
          severity: 'warn',
          confidenceScore: conf,
          flags: [...flags, { id: 'DoNotEnter', label: 'Do-not-enter rule triggered', severity: 'warn' }],
          drivers: [...drivers, { key: 'confidence', label: 'Confidence', value: `${conf.toFixed(0)}/100 (${confidenceLabel(conf)})`, raw: conf }],
        }),
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

function row(id: ScalpVerdictRow['id'], label: string, status: ScalpVerdictRow['status'], detail: string): ScalpVerdictRow {
  return { id, label, status, detail };
}

/** Match evaluateTick-style confidence from a single snapshot (0–100). */
function tickConfidenceSnapshot(snap: BookSnapshot, slope: number | null): number {
  let conf = 100;
  const spread = snap.spread ?? null;
  const churn = snap.churn ?? null;
  if (spread != null) {
    if (spread > 0.12) conf -= 35;
    else if (spread > 0.06) conf -= 18;
    else if (spread > 0.035) conf -= 8;
  }
  if (churn != null && churn >= 800) conf -= 12;
  if (slope == null) conf -= 8;
  return clamp100(conf);
}

/**
 * Bullish 4¢ scalp verdict. Execution (net+4¢) is gate 0: if the book cannot support the target net at ref size, state is AVOID.
 */
export function buildUpScalpVerdict(params: {
  net4c: Net4cEstimate;
  settings: UpScalpSettings;
  mid: number | null;
  slope: number | null;
  snap: BookSnapshot;
  wall: WallInfo;
  asks: BookLevel[];
  /** Alert kinds for the focus slug in a recent window (e.g. last 60–90s), most recent last. */
  recentAlertKinds: AlertKind[];
}): ScalpVerdict {
  const { net4c, settings, mid, slope, snap, wall, asks, recentAlertKinds } = params;
  const weakFollow = recentAlertKinds.includes('weak_follow');
  const asksEaten = recentAlertKinds.includes('asks_eaten');
  const bidWallAlert = recentAlertKinds.includes('bid_wall');
  const askWallAlert = recentAlertKinds.includes('ask_wall');
  const spread = snap.spread ?? null;
  const spreadC = spread != null ? spread * 100 : null;
  const imb = snap.imbalance ?? null;

  const tickConfidence = mid == null ? null : tickConfidenceSnapshot(snap, slope);

  const gross = net4c.net.requiredGrossCents;
  const grossTooHigh = gross != null && Number.isFinite(gross) && gross > settings.maxRequiredGrossCents;
  const executionFail = !net4c.ok || grossTooHigh;

  const spreadAvoid = spreadC != null && spreadC > settings.maxSpreadCents;

  // --- Row: Fill quality (slippage / depth cues from estimate)
  let fillStatus: ScalpVerdictRow['status'] = 'pass';
  let fillDetail = 'Depth and slip look usable for ref size.';
  if (executionFail) {
    fillStatus = 'fail';
    fillDetail = !net4c.ok
      ? `No clean path to net +${settings.targetNetCents}¢ (${net4c.flags.slice(0, 3).join(', ') || net4c.reason || 'infeasible'}).`
      : `Required gross ~${gross!.toFixed(1)}¢ exceeds max ${settings.maxRequiredGrossCents}¢.`;
  } else {
    if (net4c.flags.some((f) => f === 'WideSpread')) {
      fillStatus = 'warn';
      fillDetail = 'Wide spread — fills are noisy; size down or wait.';
    } else if (net4c.flags.some((f) => f === 'EntrySlippage' || f === 'ExitSlippage')) {
      fillStatus = 'warn';
      fillDetail = 'Material slippage on entry/exit in the model.';
    }
  }

  // --- Row: Momentum
  let momStatus: ScalpVerdictRow['status'] = 'pass';
  let momDetail =
    slope != null && slope >= settings.minMomentum
      ? `Slope +${slope.toFixed(5)}/s vs min ${settings.minMomentum}.`
      : slope != null
        ? `Slope ${slope.toFixed(5)}/s (need ≥ ${settings.minMomentum}).`
        : 'Not enough mid history for slope.';
  if (mid == null) {
    momStatus = 'warn';
    momDetail = 'No mid — cannot score momentum.';
  } else if (weakFollow) {
    momStatus = 'fail';
    momDetail = 'Weak follow-through flagged — bullish pressure not translating into mid.';
  } else if (slope == null || slope < settings.minMomentum) {
    momStatus = slope != null && slope > 0 ? 'warn' : 'fail';
    momDetail =
      momStatus === 'fail'
        ? 'Momentum too weak or wrong way for a long scalp.'
        : 'Momentum building but below your minimum.';
  }

  // --- Row: Ask pressure / support
  let pressStatus: ScalpVerdictRow['status'] = 'pass';
  const supportive = asksEaten || bidWallAlert || wall.bidWall || (imb != null && imb > 0.06);
  let pressDetail = supportive
    ? asksEaten
      ? 'Asks recently absorbed with upward bias.'
      : bidWallAlert || wall.bidWall
        ? 'Bid-side support showing.'
        : 'Order book leans bid-heavy.'
    : 'No clear ask absorption or bid support yet.';
  if (!supportive && wall.askWall) {
    pressStatus = 'warn';
    pressDetail = 'Heavy offer at touch — lifts face friction.';
  } else if (!supportive && askWallAlert) {
    pressStatus = 'warn';
    pressDetail = 'Ask-wall alert recently — watch for supply overhead.';
  } else if (!supportive) {
    pressStatus = 'warn';
  }

  // --- Row: Resistance (distance to notable ask wall above mid)
  let resStatus: ScalpVerdictRow['status'] = 'pass';
  let resDetail = 'No notable ask wall directly overhead.';
  if (mid != null) {
    const w = firstNotableWallAbove(asks, mid);
    if (w) {
      const clearance = w.price - mid;
      resDetail = `Wall ~${w.price.toFixed(4)} (+${(clearance * 100).toFixed(1)}¢ clearance).`;
      if (clearance < settings.minAskWallDistance) {
        resStatus = 'warn';
        resDetail = `Ask wall close (${(clearance * 100).toFixed(1)}¢) — need ≥ ${(settings.minAskWallDistance * 100).toFixed(1)}¢ room.`;
      }
    }
  } else {
    resStatus = 'warn';
    resDetail = 'No mid — cannot place wall distance.';
  }

  // --- Row: 4¢ feasibility (explicit)
  let n4Status: ScalpVerdictRow['status'] = 'pass';
  const profit = net4c.net.profitCents;
  const meetsTarget = profit != null && profit >= settings.targetNetCents && net4c.ok;
  let n4Detail =
    profit != null
      ? `Est net ${profit.toFixed(1)}¢ at ${settings.refShares}sh (target +${settings.targetNetCents}¢).`
      : net4c.ok
        ? `Model nets target at ${settings.refShares}sh.`
        : 'Net target not met in the model.';
  if (!net4c.ok || grossTooHigh) {
    n4Status = 'fail';
    n4Detail =
      profit != null && profit < settings.targetNetCents
        ? `Est net only ${profit.toFixed(1)}¢ — need +${settings.targetNetCents}¢.`
        : n4Detail;
  } else if (!meetsTarget && profit != null) {
    n4Status = 'warn';
    n4Detail = `Est net ${profit.toFixed(1)}¢ — borderline vs +${settings.targetNetCents}¢.`;
  }
  if (gross != null && !grossTooHigh) {
    n4Detail += ` Req gross ~${gross.toFixed(1)}¢.`;
  }

  const rows: ScalpVerdictRow[] = [
    row('fill', 'Fill quality', fillStatus, fillDetail),
    row('momentum', 'Momentum', momStatus, momDetail),
    row('pressure', 'Ask pressure / support', pressStatus, pressDetail),
    row('resistance', 'Resistance above', resStatus, resDetail),
    row('net4c', `+${settings.targetNetCents}¢ feasibility`, n4Status, n4Detail),
  ];

  const confLow = tickConfidence != null && tickConfidence < settings.minConfidence;

  let state: ScalpVerdict['state'];
  let headline: string;

  if (executionFail) {
    state = 'AVOID';
    headline =
      grossTooHigh && gross != null
        ? `Required gross ~${gross.toFixed(1)}¢ exceeds your ${settings.maxRequiredGrossCents}¢ cap.`
        : 'Net target not feasible at ref size — AVOID.';
  } else if (spreadAvoid) {
    state = 'AVOID';
    headline = `Spread ${spreadC != null ? spreadC.toFixed(1) : '—'}¢ vs max ${settings.maxSpreadCents}¢ — AVOID.`;
  } else if (weakFollow) {
    state = 'AVOID';
    headline = 'Weak follow-through — stand down.';
  } else {
    const anyFail = rows.some((r) => r.status === 'fail');
    const anyWarn = rows.some((r) => r.status === 'warn') || confLow;
    if (anyFail) {
      state = 'WAIT';
      headline = 'Mixed tape — fix failed checks before scaling.';
    } else if (anyWarn) {
      state = 'WAIT';
      headline = confLow
        ? `Confidence ${tickConfidence!.toFixed(0)} below min ${settings.minConfidence} — wait for cleaner context.`
        : 'Close but not clean — wait for confirmation.';
    } else {
      state = 'READY';
      headline = 'READY — rules line up for a long scalp window.';
    }
  }

  return { state, headline, rows, tickConfidence };
}
