import type { PtbReactionAnalysis } from './spotVsPtb';

export type PtbControlSignal = 'UP_CONTROL' | 'DOWN_CONTROL' | 'TRANSITION' | 'REJECTION' | 'NO_EDGE';

/** When one CLOB leg is already very rich, tape-vs-PTB “UP/DOWN” must not read like token rotation. */
function impliedDominantSide(
  lastProbUp: number | null | undefined,
  lastProbDown: number | null | undefined,
): 'up' | 'down' | null {
  let u = lastProbUp != null && Number.isFinite(lastProbUp) ? lastProbUp : null;
  let d = lastProbDown != null && Number.isFinite(lastProbDown) ? lastProbDown : null;
  if (u != null && d == null) d = 1 - u;
  else if (d != null && u == null) u = 1 - d;
  if (u == null || d == null) return null;
  u = Math.max(0.001, Math.min(0.999, u));
  d = Math.max(0.001, Math.min(0.999, d));
  if (d >= 0.93 && d > u + 0.06) return 'down';
  if (u >= 0.93 && u > d + 0.06) return 'up';
  return null;
}

export function classifyPtbControlSignal(params: {
  position: 'ABOVE' | 'BELOW' | 'AT';
  momentum: 'UP' | 'DOWN' | 'NEUTRAL';
  interaction: 'rejection' | 'hold' | 'break' | 'hover' | 'drift';
  reaction: PtbReactionAnalysis;
  dwellAboveMs: number;
  dwellBelowMs: number;
  dwellAtMs: number;
  distanceUsd: number;
  /** OLS tick slope ($/s); when present, sharp fade vs position forces TRANSITION earlier. */
  slopeUsdPerSec?: number;
  /** Optional CLOB mids (0..1) — disambiguate tape language from priced-in favorites late in the round. */
  lastProbUp?: number | null;
  lastProbDown?: number | null;
}): { signal: PtbControlSignal; blurb: string } {
  const {
    position,
    momentum,
    interaction,
    reaction,
    dwellAboveMs,
    dwellBelowMs,
    dwellAtMs,
    distanceUsd,
    slopeUsdPerSec,
    lastProbUp,
    lastProbDown,
  } = params;
  const eps = Math.max(reaction.eps, 1e-9);
  const absD = Math.abs(distanceUsd);
  const total = dwellAboveMs + dwellBelowMs + dwellAtMs;
  const atShare = total > 0 ? dwellAtMs / total : 0;
  const aboveShare = total > 0 ? dwellAboveMs / total : 0;
  const belowShare = total > 0 ? dwellBelowMs / total : 0;
  const kind = reaction.kind;

  if (kind === 'choppy_at_line') {
    return { signal: 'NO_EDGE', blurb: 'Repeated crosses through PTB — chop, no clean control.' };
  }

  if (interaction === 'rejection' || kind === 'rejecting_off_line') {
    const lean =
      distanceUsd < -eps * 0.25
        ? 'Sub-PTB tape — rejection often reinforces lower-side continuation.'
        : distanceUsd > eps * 0.25
          ? 'Above PTB tape — rejection often reinforces higher-side continuation.'
          : 'At the band — failed hold through; wait for the next separation.';
    return { signal: 'REJECTION', blurb: lean };
  }

  if (position === 'AT' || atShare > 0.4) {
    return { signal: 'NO_EDGE', blurb: 'Mostly inside the PTB interaction band — negotiate, don’t force edge.' };
  }

  if (kind === 'break_probe') {
    return { signal: 'TRANSITION', blurb: 'Early separation from PTB — control may be shifting; confirm hold vs reclaim.' };
  }

  const slope = slopeUsdPerSec;
  if (slope != null && Number.isFinite(slope)) {
    /** ~$/s: scale with band noise; floor catches liquid names where eps is tiny. */
    const mag = Math.max(reaction.eps / 20_000, 2.5e-4);
    const negCut = -mag;
    const posCut = mag;
    if (position === 'ABOVE' && slope < negCut) {
      return {
        signal: 'TRANSITION',
        blurb: 'Above PTB but tick slope is fading — UP control may be slipping before candles confirm.',
      };
    }
    if (position === 'BELOW' && slope > posCut) {
      return {
        signal: 'TRANSITION',
        blurb: 'Below PTB but tick slope is lifting — DOWN control may be slipping before candles confirm.',
      };
    }
  }

  const mismatchUp = position === 'ABOVE' && momentum === 'DOWN';
  const mismatchDn = position === 'BELOW' && momentum === 'UP';
  if (mismatchUp || mismatchDn) {
    const rich = impliedDominantSide(lastProbUp, lastProbDown);
    if (mismatchDn && rich === 'down') {
      const d = lastProbDown != null && Number.isFinite(lastProbDown) ? lastProbDown : null;
      const u = lastProbUp != null && Number.isFinite(lastProbUp) ? lastProbUp : d != null ? 1 - d : null;
      const pct = d != null ? Math.round(d * 100) : null;
      return {
        signal: 'TRANSITION',
        blurb:
          pct != null && u != null
            ? `Below PTB but candles lift — spot vs PTB noise. Down is already ~${pct}¢ vs Up ~${Math.round(u * 100)}¢ on the board — read this as strike proximity / scalps, not “rotate into cheap Up shares” unless Dual agrees.`
            : 'Below PTB but candles lift — spot vs PTB bounce risk. One outcome is already priced very rich; do not treat tape lift as a token reversal unless Dual agrees.',
      };
    }
    if (mismatchUp && rich === 'up') {
      const uu = lastProbUp != null && Number.isFinite(lastProbUp) ? lastProbUp : null;
      const dd = lastProbDown != null && Number.isFinite(lastProbDown) ? lastProbDown : uu != null ? 1 - uu : null;
      const pctU = uu != null ? Math.round(uu * 100) : null;
      return {
        signal: 'TRANSITION',
        blurb:
          pctU != null && dd != null
            ? `Above PTB but candles fade — spot vs PTB noise. Up is already ~${pctU}¢ vs Down ~${Math.round(dd * 100)}¢ on the board — read this as strike chop, not “rotate into cheap Down shares” unless Dual agrees.`
            : 'Above PTB but candles fade — spot vs PTB slip risk. One outcome is already priced very rich; do not treat tape softness as a token reversal unless Dual agrees.',
      };
    }
    return {
      signal: 'TRANSITION',
      blurb: mismatchUp
        ? 'Above PTB but downward candle pressure — spot may peel under PTB (underlying vs strike, not the same as the CLOB “Down” token “winning”).'
        : 'Below PTB but upward candle pressure — spot may bounce toward PTB (underlying vs strike, not the same as the CLOB “Up” token “winning”).',
    };
  }

  if (reaction.extensionFollowThrough === 'stall' && absD > eps * 1.2) {
    if (position === 'ABOVE' && distanceUsd > 0) {
      return { signal: 'TRANSITION', blurb: 'Extension after PTB contact is fading while still above — fragile hold.' };
    }
    if (position === 'BELOW' && distanceUsd < 0) {
      return { signal: 'TRANSITION', blurb: 'Extension after PTB contact is fading while still below — fragile hold.' };
    }
  }

  if (position === 'ABOVE') {
    const supportive = momentum === 'UP' || (momentum === 'NEUTRAL' && aboveShare >= belowShare * 0.82);
    if (!supportive || aboveShare < 0.18) {
      return { signal: 'NO_EDGE', blurb: 'Above PTB but dwell / momentum do not yet read as committed UP control.' };
    }
    return { signal: 'UP_CONTROL', blurb: 'Spot holding above PTB with time + flow aligned — UP side in control.' };
  }

  if (position === 'BELOW') {
    const supportive = momentum === 'DOWN' || (momentum === 'NEUTRAL' && belowShare >= aboveShare * 0.82);
    if (!supportive || belowShare < 0.18) {
      return { signal: 'NO_EDGE', blurb: 'Below PTB but dwell / momentum do not yet read as committed DOWN control.' };
    }
    return { signal: 'DOWN_CONTROL', blurb: 'Spot holding below PTB with time + flow aligned — DOWN side in control.' };
  }

  return { signal: 'NO_EDGE', blurb: 'Mixed tape vs PTB — no single control read.' };
}
