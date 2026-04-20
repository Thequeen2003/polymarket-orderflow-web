/** Click-to-plan trade assistant: range projection + live hold / TP / cut guidance. */

export type TradeLane = 'up' | 'down';

export type GapLite = {
  lo: number;
  hi: number;
  strength10: number;
  active: boolean;
  exitWall: number | null;
};

export type HiddenRanges = {
  bullish: boolean;
  safeLo: number;
  safeHi: number;
  likelyLo: number;
  likelyHi: number;
  stretchLo: number;
  stretchHi: number;
  wall: number | null;
};

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Project safe / likely / stretch / wall from entry, desired exit, and vacuum gap. */
export function estimateHiddenRanges(params: {
  entry: number;
  desiredExit: number;
  gap: GapLite | null;
}): HiddenRanges {
  const E = clamp01(params.entry);
  const D = clamp01(params.desiredExit);
  const bullish = D >= E;
  const gap = params.gap;

  if (bullish) {
    const span = Math.max(D - E, 0.015);
    const gapHi = gap != null ? gap.hi : Math.min(0.97, D + span * 0.5);
    const gapLo = gap != null ? gap.lo : Math.max(0.03, E - span * 0.35);
    void gapLo;
    const wall = gap?.exitWall != null ? clamp01(gap.exitWall) : clamp01(Math.min(0.985, D + span * 1.25));

    const safeLo = clamp01(E + span * 0.08);
    const safeHi = clamp01(E + span * 0.42);
    let likelyLo = clamp01(E + span * 0.26);
    let likelyHi = clamp01(Math.min(D + span * 0.1, gapHi, wall - 0.012));
    let stretchLo = clamp01(Math.max(likelyHi - span * 0.06, D + span * 0.02));
    let stretchHi = clamp01(Math.min(wall - 0.004, gapHi + span * 0.12, 0.99));

    if (likelyHi < likelyLo + 0.008) likelyHi = clamp01(likelyLo + span * 0.18);
    if (stretchHi < stretchLo + 0.006) stretchHi = clamp01(Math.min(wall - 0.002, stretchLo + span * 0.22));
    if (safeHi <= safeLo) {
      const mid = E + span * 0.25;
      return {
        bullish,
        safeLo: clamp01(mid - 0.015),
        safeHi: clamp01(mid + 0.015),
        likelyLo: clamp01(mid + 0.01),
        likelyHi: clamp01(D + 0.01),
        stretchLo: clamp01(D + 0.008),
        stretchHi: clamp01(wall - 0.005),
        wall,
      };
    }
    return { bullish, safeLo, safeHi, likelyLo, likelyHi, stretchLo, stretchHi, wall };
  }

  const span = Math.max(E - D, 0.015);
  const gapLo = gap != null ? gap.lo : Math.max(0.03, D - span * 0.5);
  const gapHi = gap != null ? gap.hi : Math.min(0.97, E + span * 0.35);
  void gapHi;
  const wall = gap?.exitWall != null ? clamp01(gap.exitWall) : clamp01(Math.max(0.015, D - span * 1.25));

  const safeHi = clamp01(E - span * 0.08);
  const safeLo = clamp01(E - span * 0.42);
  let likelyHi = clamp01(E - span * 0.26);
  let likelyLo = clamp01(Math.max(D - span * 0.1, gapLo, wall + 0.012));
  let stretchHi = clamp01(Math.min(likelyLo + span * 0.06, D - span * 0.02));
  let stretchLo = clamp01(Math.max(wall + 0.004, gapLo - span * 0.12, 0.01));

  if (likelyLo > likelyHi - 0.008) likelyLo = clamp01(likelyHi - span * 0.18);
  if (stretchLo > stretchHi - 0.006) stretchLo = clamp01(Math.max(wall + 0.002, stretchHi - span * 0.22));
  if (safeLo >= safeHi) {
    const mid = E - span * 0.25;
    return {
      bullish,
      safeHi: clamp01(mid + 0.015),
      safeLo: clamp01(mid - 0.015),
      likelyHi: clamp01(mid - 0.01),
      likelyLo: clamp01(D - 0.01),
      stretchHi: clamp01(D - 0.008),
      stretchLo: clamp01(wall + 0.005),
      wall,
    };
  }
  return { bullish, safeLo, safeHi, likelyLo, likelyHi, stretchLo, stretchHi, wall };
}

export type TradeAction = 'HOLD' | 'TAKE_PROFIT' | 'CUT_NOW';

export type TradeGuidance = {
  status: string;
  action: TradeAction;
  reversalRisk01: number;
  detail: string;
};

function meanAbsSlopes(history: number[]): { now: number; prior: number } {
  if (history.length < 5) return { now: 0.02, prior: 0.02 };
  const slopes: number[] = [];
  for (let i = 1; i < history.length; i++) {
    slopes.push(history[i]! - history[i - 1]!);
  }
  const recent = slopes.slice(-3);
  const prior = slopes.slice(-7, -3);
  const now = recent.length ? recent.reduce((s, x) => s + Math.abs(x), 0) / recent.length : 0;
  const pr = prior.length ? prior.reduce((s, x) => s + Math.abs(x), 0) / prior.length : now;
  return { now, prior: pr };
}

export function computeLiveGuidance(params: {
  bullish: boolean;
  entry: number;
  desiredExit: number;
  current: number;
  ranges: HiddenRanges;
  sessionPeak: number;
  sessionTrough: number;
  midHistory: number[];
}): TradeGuidance {
  const { bullish, entry, desiredExit, current, ranges, sessionPeak, sessionTrough, midHistory } = params;
  const wall = ranges.wall;
  const { now: momNow, prior: momPrior } = meanAbsSlopes(midHistory);
  const momentumWeak = momPrior > 1e-9 && momNow < momPrior * 0.62;
  const momentumWasHigher = momPrior > momNow * 1.18;
  const shrinkTape = momNow < 0.0035;

  let nearWall = false;
  if (wall != null) {
    nearWall = bullish ? wall - current < 0.034 : current - wall < 0.034;
  }

  const rollingBackBull = bullish && sessionPeak > entry + 0.012 && current < sessionPeak - 0.01;
  const rollingBackBear = !bullish && sessionTrough < entry - 0.012 && current > sessionTrough + 0.01;
  const rollingBack = rollingBackBull || rollingBackBear;

  let reversalRisk01 = 0.12;
  if (momentumWeak) reversalRisk01 += 0.22;
  if (momentumWasHigher) reversalRisk01 += 0.12;
  if (shrinkTape) reversalRisk01 += 0.14;
  if (nearWall) reversalRisk01 += 0.2;
  if (rollingBack) reversalRisk01 += 0.22;
  reversalRisk01 = Math.max(0, Math.min(1, reversalRisk01));

  const inSafe =
    bullish && current >= ranges.safeLo && current <= ranges.safeHi
      ? true
      : !bullish && current <= ranges.safeHi && current >= ranges.safeLo;
  const inLikely =
    bullish && current >= ranges.likelyLo && current <= ranges.likelyHi
      ? true
      : !bullish && current <= ranges.likelyHi && current >= ranges.likelyLo;
  const inStretch =
    bullish && current >= ranges.stretchLo && current <= ranges.stretchHi
      ? true
      : !bullish && current <= ranges.stretchHi && current >= ranges.stretchLo;

  const pastDesired = bullish ? current >= desiredExit - 0.004 : current <= desiredExit + 0.004;
  const underwater = bullish ? current < entry - 0.008 : current > entry + 0.008;

  let status = 'Holding';
  if (underwater) status = 'Underwater vs entry';
  else if (pastDesired && inStretch) status = 'At / past target zone';
  else if (pastDesired) status = 'Approaching target';
  else if (inLikely) status = inSafe ? 'Holding clean' : 'In likely range';
  else if (inStretch) status = 'At stretch';
  else if (nearWall) status = 'Wall close';
  if (momentumWeak && !underwater) status = 'Momentum weakening';
  if (reversalRisk01 >= 0.48 && reversalRisk01 < 0.72) status = 'Reversal risk rising';

  let action: TradeAction = 'HOLD';
  let detail = 'Hold — structure still supports the plan band.';

  if (underwater && reversalRisk01 > 0.55) {
    action = 'CUT_NOW';
    detail = 'Cut now — trade is underwater and flow is deteriorating.';
  } else if (rollingBack && reversalRisk01 > 0.5 && (bullish ? current >= entry : current <= entry)) {
    action = 'TAKE_PROFIT';
    detail = 'Take profit — price is giving back progress after a push; bank it before reversal.';
  } else if (reversalRisk01 > 0.74 && (bullish ? current >= entry + 0.01 : current <= entry - 0.01)) {
    action = 'TAKE_PROFIT';
    detail = 'Take profit now — reversal pressure is high while you still have edge.';
  } else if (reversalRisk01 > 0.78) {
    action = 'CUT_NOW';
    detail = 'Cut now — reversal starting before a clean test of your desired exit.';
  } else if (pastDesired && (momentumWeak || reversalRisk01 > 0.45)) {
    action = 'TAKE_PROFIT';
    detail = 'Take profit — target zone reached and continuation is weakening.';
  } else if (inStretch && nearWall && shrinkTape) {
    action = 'TAKE_PROFIT';
    detail = 'Take profit — stretch + slow tape into wall: don’t insist on the last tick.';
  }

  if (action === 'HOLD' && pastDesired && !momentumWeak) {
    detail = 'Hold — target in play with tape still supportive; watch stretch + wall.';
  }

  return { status, action, reversalRisk01, detail };
}
