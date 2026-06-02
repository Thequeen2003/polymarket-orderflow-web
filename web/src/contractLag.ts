/**
 * Contract lag: how far the outcome mid is behind desk model fair (catch-up room in ¢).
 *
 *   lagUp   = (P_model_up   − market_up)   × 100
 *   lagDown = (P_model_down − market_down) × 100
 *
 * Positive lag = that side is cheap vs model (room to jump, e.g. Down 56¢ → fair 72¢ = +16¢ lag).
 */

import { EDGE_TRADE_THRESHOLD } from './probabilityEdgeScalp';

export const CONTRACT_LAG_MIN_CENTS = 5;
export const CONTRACT_LAG_STRONG_CENTS = 10;
/** CLOB mid older than this is flagged stale in the UI. */
export const CONTRACT_LAG_STALE_MS = 10_000;

export type ProbTick = { t: number; v: number };

export type ContractLagPhase = 'lagging' | 'catching_up' | 'aligned';

export type ContractLagGeo = 'ABOVE' | 'BELOW' | 'IN_BAND';

export type ContractLagReadout = {
  modelUp: number;
  modelDown: number;
  marketUp: number;
  marketDown: number;
  lagUpCents: number;
  lagDownCents: number;
  favoredSide: 'up' | 'down' | 'even';
  favoredLabel: string;
  /** Largest positive lag on either side (¢). */
  lagCents: number;
  edgePp: number;
  /** Recent mid change over lookback (¢), not forward projection. */
  marketDeltaUpCents: number | null;
  marketDeltaDownCents: number | null;
  phase: ContractLagPhase;
  phaseLabel: string;
  repricingIntoEdge: boolean | null;
  geo: ContractLagGeo | null;
  geoAligned: boolean;
  tradeable: boolean;
  call: string;
  detail: string;
  marketUpdatedAtMs: number | null;
  marketAgeSec: number | null;
  marketStale: boolean;
};

function clampProb01(p: number): number {
  return Math.max(0.01, Math.min(0.99, p));
}

function fmtCentsLag(c: number): string {
  return `${c >= 0 ? '+' : ''}${c.toFixed(1)}¢`;
}

function geoAlignedWithSide(geo: ContractLagGeo | null, side: 'up' | 'down'): boolean {
  if (geo == null || side === 'even' as never) return false;
  if (side === 'up') return geo === 'ABOVE';
  if (side === 'down') return geo === 'BELOW';
  return false;
}

/** Change in mid over recent window (live ticks, not forward projection). */
export function recentProbDelta01(pts: ProbTick[], windowMs = 30_000): number | null {
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1]!;
  if (!Number.isFinite(last.v)) return null;
  const cutoff = last.t - windowMs;
  for (let i = pts.length - 2; i >= 0; i--) {
    const p = pts[i]!;
    if (p.t <= cutoff && Number.isFinite(p.v)) return last.v - p.v;
  }
  const first = pts[0]!;
  return Number.isFinite(first.v) ? last.v - first.v : null;
}

/** Catch-up: favored side mid rising, or complement falling when edge is negative. */
export function contractRepricingIntoEdge(
  edgePp: number,
  deltaUpCents: number | null,
  deltaDownCents: number | null,
): boolean | null {
  const threshold = 0.15;
  if (Math.abs(edgePp) < EDGE_TRADE_THRESHOLD * 100) return null;
  if (edgePp > 0) {
    return deltaUpCents != null && deltaUpCents > threshold;
  }
  return (
    (deltaDownCents != null && deltaDownCents > threshold) ||
    (deltaUpCents != null && deltaUpCents < -threshold)
  );
}

function inferPhase(params: {
  lagCents: number;
  favoredSide: 'up' | 'down' | 'even';
  marketDeltaUpCents: number | null;
  marketDeltaDownCents: number | null;
  repricingIntoEdge: boolean | null;
}): { phase: ContractLagPhase; phaseLabel: string } {
  const { lagCents, favoredSide, marketDeltaUpCents, marketDeltaDownCents, repricingIntoEdge } = params;

  if (lagCents < CONTRACT_LAG_MIN_CENTS) {
    return { phase: 'aligned', phaseLabel: 'Aligned — mid ≈ model' };
  }

  const delta =
    favoredSide === 'up'
      ? marketDeltaUpCents
      : favoredSide === 'down'
        ? marketDeltaDownCents
        : null;

  const movingTowardModel =
    repricingIntoEdge === true ||
    (delta != null && Number.isFinite(delta) && ((favoredSide === 'up' && delta > 0.2) || (favoredSide === 'down' && delta > 0.2)));

  if (movingTowardModel) {
    return { phase: 'catching_up', phaseLabel: 'Catching up — repricing toward model' };
  }

  return { phase: 'lagging', phaseLabel: 'Lagging — mispriced, jump not started yet' };
}

/** Desk model fair vs market mids → catch-up lag on each outcome. */
export function computeContractLagReadout(params: {
  modelPUp: number;
  marketUp: number;
  marketDown?: number | null;
  probUpDelta01?: number | null;
  probDownDelta01?: number | null;
  edgePp?: number | null;
  repricingIntoEdge?: boolean | null;
  geo?: ContractLagGeo | null;
  upLabel?: string;
  downLabel?: string;
  marketUpdatedAtMs?: number | null;
  nowMs?: number;
}): ContractLagReadout {
  const modelUp = clampProb01(params.modelPUp);
  const modelDown = clampProb01(1 - modelUp);
  const marketUp = clampProb01(params.marketUp);
  const marketDown = clampProb01(params.marketDown ?? 1 - marketUp);

  const lagUpCents = (modelUp - marketUp) * 100;
  const lagDownCents = (modelDown - marketDown) * 100;
  const edgePp = params.edgePp ?? (modelUp - marketUp) * 100;

  const upName = params.upLabel ?? 'UP';
  const downName = params.downLabel ?? 'DOWN';

  let favoredSide: 'up' | 'down' | 'even' = 'even';
  let lagCents = 0;

  if (lagUpCents > lagDownCents && lagUpCents > 0) {
    favoredSide = 'up';
    lagCents = lagUpCents;
  } else if (lagDownCents > lagUpCents && lagDownCents > 0) {
    favoredSide = 'down';
    lagCents = lagDownCents;
  } else if (Math.abs(lagUpCents) >= Math.abs(lagDownCents)) {
    favoredSide = lagUpCents >= 0 ? 'up' : 'down';
    lagCents = Math.max(lagUpCents, lagDownCents);
  } else {
    favoredSide = lagDownCents >= 0 ? 'down' : 'up';
    lagCents = Math.max(lagUpCents, lagDownCents);
  }

  const favoredLabel = favoredSide === 'up' ? upName : favoredSide === 'down' ? downName : 'Even';

  const marketDeltaUpCents =
    params.probUpDelta01 != null && Number.isFinite(params.probUpDelta01) ? params.probUpDelta01 * 100 : null;
  const marketDeltaDownCents =
    params.probDownDelta01 != null && Number.isFinite(params.probDownDelta01) ? params.probDownDelta01 * 100 : null;

  const repricing =
    params.repricingIntoEdge ??
    contractRepricingIntoEdge(edgePp, marketDeltaUpCents, marketDeltaDownCents);

  const { phase, phaseLabel } = inferPhase({
    lagCents: Math.max(lagUpCents, lagDownCents, 0),
    favoredSide,
    marketDeltaUpCents,
    marketDeltaDownCents,
    repricingIntoEdge: repricing,
  });

  const geo = params.geo ?? null;
  const geoAligned = favoredSide !== 'even' && geoAlignedWithSide(geo, favoredSide);

  const edgeThresholdPp = EDGE_TRADE_THRESHOLD * 100;

  const nowMs = params.nowMs ?? Date.now();
  const marketUpdatedAtMs = params.marketUpdatedAtMs ?? null;
  const marketAgeSec =
    marketUpdatedAtMs != null && Number.isFinite(marketUpdatedAtMs)
      ? Math.max(0, (nowMs - marketUpdatedAtMs) / 1000)
      : null;
  const marketStale = marketAgeSec != null && marketAgeSec * 1000 > CONTRACT_LAG_STALE_MS;

  const tradeable =
    !marketStale &&
    favoredSide !== 'even' &&
    lagCents >= CONTRACT_LAG_MIN_CENTS &&
    Math.abs(edgePp) >= edgeThresholdPp &&
    geoAligned;

  let call: string;
  let detail: string;

  if (tradeable && phase === 'lagging') {
    call = `BUY ${favoredLabel} · lag ${fmtCentsLag(lagCents)}`;
    detail = `${favoredLabel} mid cheap vs model — spot ${geo === 'BELOW' ? 'below' : geo === 'ABOVE' ? 'above' : 'near'} PTB, book not caught up yet`;
  } else if (marketStale) {
    call = 'Stale mids — refresh';
    detail = `Contract mids ${marketAgeSec != null ? `${Math.round(marketAgeSec)}s` : '?'} old — lag/edge frozen until CLOB updates`;
  } else if (tradeable && phase === 'catching_up') {
    call = `${favoredLabel} jumping · lag ${fmtCentsLag(lagCents)}`;
    detail = `Catch-up in progress — mid moving toward model fair`;
  } else if (lagCents >= CONTRACT_LAG_STRONG_CENTS && !geoAligned) {
    call = `Lag ${fmtCentsLag(lagCents)} on ${favoredLabel}`;
    detail = `Mispriced but spot geometry (${geo?.replace('_', ' ') ?? '—'}) doesn't confirm — wait`;
  } else if (lagCents >= CONTRACT_LAG_MIN_CENTS) {
    call = `Watch ${favoredLabel} · ${fmtCentsLag(lagCents)} room`;
    detail = phaseLabel;
  } else {
    call = 'No lag';
    detail = 'Market mid ≈ desk model on both sides';
  }

  return {
    modelUp,
    modelDown,
    marketUp,
    marketDown,
    lagUpCents,
    lagDownCents,
    favoredSide,
    favoredLabel,
    lagCents,
    edgePp,
    marketDeltaUpCents,
    marketDeltaDownCents,
    phase,
    phaseLabel,
    repricingIntoEdge: repricing,
    geo,
    geoAligned,
    tradeable,
    call,
    detail,
    marketUpdatedAtMs,
    marketAgeSec,
    marketStale,
  };
}
