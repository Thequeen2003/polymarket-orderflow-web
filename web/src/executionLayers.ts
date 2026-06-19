/**
 * Three-layer execution desk: Bias (always) · Entry gates (both sides) · Execution (when ready).
 */

import { computeBilateralEdge } from './bilateralEdge';

export type BiasStrength = 'strong' | 'weak' | 'neutral';

export type MarketBias = {
  direction: 'up' | 'down' | 'none';
  strength: BiasStrength;
  emoji: string;
  headline: string;
  detail: string;
};

export type EntrySideGateRow = {
  side: 'up' | 'down';
  sideLabel: string;
  probPct: number | null;
  probOk: boolean;
  edgePp: number | null;
  edgeOk: boolean;
  momentumOk: boolean;
  momentumNote: string;
  baseReady: boolean;
  passCount: number;
};

export type EntryEligibilityStatus = 'NOT_READY' | 'CONFIRMING' | 'READY';

export type EntryEligibility = {
  status: EntryEligibilityStatus;
  statusLabel: string;
  up: EntrySideGateRow;
  down: EntrySideGateRow;
  footer: string;
};

export type SideCheckLite = {
  side: 'up' | 'down';
  sideLabel: string;
  probPct: number | null;
  probOk: boolean;
  edgePp: number | null;
  edgeOk: boolean;
  passCount: number;
};

function fmtEdgePp(pp: number | null): string {
  if (pp == null || !Number.isFinite(pp)) return '—';
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(0)}pp`;
}

/** Layer 1 — lean from model prob, bilateral edge, and spot direction only. */
export function computeMarketBias(params: {
  modelPUp: number | null;
  pMktUp: number | null;
  pMktDown?: number | null;
  modelPDown?: number | null;
  spotDirection?: 'UP' | 'DOWN' | 'FLAT' | null;
  upLabel?: string;
  downLabel?: string;
}): MarketBias {
  const edges = computeBilateralEdge(params);
  const spot = params.spotDirection ?? 'FLAT';
  let upPts = 0;
  let downPts = 0;

  if (edges.modelPUp != null) {
    if (edges.modelPUp >= 0.62) upPts += 2;
    else if (edges.modelPUp > 0.52) upPts += 1;
    if (edges.modelPUp <= 0.38) downPts += 2;
    else if (edges.modelPUp < 0.48) downPts += 1;
  }
  if (edges.edgeUpPp != null && edges.edgeUpPp > 0) {
    upPts += edges.edgeUpPp >= 8 ? 2 : 1;
  }
  if (edges.edgeDownPp != null && edges.edgeDownPp > 0) {
    downPts += edges.edgeDownPp >= 8 ? 2 : 1;
  }
  if (spot === 'UP') upPts += 1;
  else if (spot === 'DOWN') downPts += 1;

  const margin = upPts - downPts;
  if (Math.abs(margin) < 2 || (upPts <= 2 && downPts <= 2 && Math.abs(margin) <= 1)) {
    return {
      direction: 'none',
      strength: 'neutral',
      emoji: '⚪',
      headline: 'NO BIAS',
      detail: 'Chop / flat — no clear lean',
    };
  }

  if (margin >= 2) {
    const strength: BiasStrength = margin >= 4 ? 'strong' : 'weak';
    const upLabel = params.upLabel ?? 'UP';
    return {
      direction: 'up',
      strength,
      emoji: '🟢',
      headline: `${upLabel} BIAS (${strength})`,
      detail: `Model ${edges.modelPUp != null ? `${(edges.modelPUp * 100).toFixed(0)}%` : '—'} · edge ${fmtEdgePp(edges.edgeUpPp)} · spot ${spot.toLowerCase()}`,
    };
  }

  const strength: BiasStrength = margin <= -4 ? 'strong' : 'weak';
  const downLabel = params.downLabel ?? 'DOWN';
  return {
    direction: 'down',
    strength,
    emoji: '🔴',
    headline: `${downLabel} BIAS (${strength})`,
    detail: `Model ${edges.modelPDown != null ? `${(edges.modelPDown * 100).toFixed(0)}%` : '—'} · edge ${fmtEdgePp(edges.edgeDownPp)} · spot ${spot.toLowerCase()}`,
  };
}

function buildSideGateRow(
  check: SideCheckLite,
  momentum: { pass: boolean; detail: string },
): EntrySideGateRow {
  return {
    side: check.side,
    sideLabel: check.sideLabel,
    probPct: check.probPct,
    probOk: check.probOk,
    edgePp: check.edgePp,
    edgeOk: check.edgeOk,
    momentumOk: momentum.pass,
    momentumNote: momentum.detail,
    baseReady: check.passCount === 3,
    passCount: check.passCount + (momentum.pass ? 1 : 0),
  };
}

/** Layer 2 — both sides always, equal detail. */
export function buildEntryEligibility(args: {
  up: SideCheckLite;
  down: SideCheckLite;
  momUp: { pass: boolean; detail: string };
  momDown: { pass: boolean; detail: string };
  phase: 'WAIT' | 'NO_TRADE' | 'ALERT' | 'ENTER';
}): EntryEligibility {
  const up = buildSideGateRow(args.up, args.momUp);
  const down = buildSideGateRow(args.down, args.momDown);

  let status: EntryEligibilityStatus = 'NOT_READY';
  let statusLabel = 'NOT READY';
  if (args.phase === 'ENTER') {
    status = 'READY';
    statusLabel = 'READY TO ENTER';
  } else if (args.phase === 'ALERT') {
    status = 'CONFIRMING';
    statusLabel = 'CONFIRMING — hold gates';
  }

  const footer =
    status === 'READY'
      ? 'All gates passed — execute on active side'
      : status === 'CONFIRMING'
        ? 'Direction set — waiting for confirmation hold + remaining gates'
        : 'No trade — waiting for UP or DOWN to pass all entry gates';

  return { status, statusLabel, up, down, footer };
}

export function sideCheckToLite(check: {
  side: 'up' | 'down';
  sideLabel: string;
  probPct: number | null;
  probOk: boolean;
  edgePp: number | null;
  edgeOk: boolean;
  passCount: number;
}): SideCheckLite {
  return {
    side: check.side,
    sideLabel: check.sideLabel,
    probPct: check.probPct,
    probOk: check.probOk,
    edgePp: check.edgePp,
    edgeOk: check.edgeOk,
    passCount: check.passCount,
  };
}
