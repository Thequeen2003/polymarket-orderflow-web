import type { PtbReactionAnalysis } from './spotVsPtb';

export type PtbControlSignal = 'UP_CONTROL' | 'DOWN_CONTROL' | 'TRANSITION' | 'REJECTION' | 'NO_EDGE';

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
}): { signal: PtbControlSignal; blurb: string } {
  const { position, momentum, interaction, reaction, dwellAboveMs, dwellBelowMs, dwellAtMs, distanceUsd, slopeUsdPerSec } = params;
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
    return {
      signal: 'TRANSITION',
      blurb: mismatchUp
        ? 'Above PTB but downward pressure — UP control weakening; watch for DOWN rotation.'
        : 'Below PTB but upward pressure — DOWN control weakening; watch for UP rotation.',
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
    const supportive = momentum === 'UP' || (momentum === 'NEUTRAL' && aboveShare >= belowShare * 0.88);
    if (!supportive || aboveShare < 0.22) {
      return { signal: 'NO_EDGE', blurb: 'Above PTB but dwell / momentum do not yet read as committed UP control.' };
    }
    return { signal: 'UP_CONTROL', blurb: 'Spot holding above PTB with time + flow aligned — UP side in control.' };
  }

  if (position === 'BELOW') {
    const supportive = momentum === 'DOWN' || (momentum === 'NEUTRAL' && belowShare >= aboveShare * 0.88);
    if (!supportive || belowShare < 0.22) {
      return { signal: 'NO_EDGE', blurb: 'Below PTB but dwell / momentum do not yet read as committed DOWN control.' };
    }
    return { signal: 'DOWN_CONTROL', blurb: 'Spot holding below PTB with time + flow aligned — DOWN side in control.' };
  }

  return { signal: 'NO_EDGE', blurb: 'Mixed tape vs PTB — no single control read.' };
}
