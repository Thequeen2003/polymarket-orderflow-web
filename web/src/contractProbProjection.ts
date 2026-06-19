import { computeMomentumProjection, type ProjectionTick } from './momentumProjection';
import { PRICE_PREDICTION_HORIZON_SECS, formatHorizonLabel } from './pricePredictionSignal';

export type ContractProbHorizonCell = {
  label: string;
  horizonSec: number;
  up01: number | null;
  down01: number | null;
  deltaUp01: number | null;
  deltaDown01: number | null;
  confidenceUp: number | null;
  confidenceDown: number | null;
};

export type ContractProbProjectionGrid = {
  cells: ContractProbHorizonCell[];
};

function normalizeBinaryFlexible(
  up01: number | null,
  down01: number | null,
): { up: number | null; down: number | null } {
  const uOk = up01 != null && Number.isFinite(up01);
  const dOk = down01 != null && Number.isFinite(down01);
  if (!uOk && !dOk) return { up: null, down: null };

  if (uOk && !dOk) {
    const u = Math.max(0, Math.min(1, up01!));
    return { up: u, down: 1 - u };
  }
  if (!uOk && dOk) {
    const d = Math.max(0, Math.min(1, down01!));
    return { up: 1 - d, down: d };
  }

  const s = up01! + down01!;
  if (!Number.isFinite(s) || s <= 1e-9) return { up: null, down: null };
  const u = Math.max(0, Math.min(1, up01! / s));
  return { up: u, down: 1 - u };
}

export function fmtContractCents(v01: number | null | undefined): string {
  if (v01 == null || !Number.isFinite(v01)) return '—';
  const c = v01 * 100;
  return c >= 10 ? `${c.toFixed(1)}¢` : `${c.toFixed(2)}¢`;
}

export function fmtContractDeltaCents(d01: number | null | undefined): string {
  if (d01 == null || !Number.isFinite(d01)) return '—';
  const c = d01 * 100;
  if (Math.abs(c) < 0.05) return '0¢';
  return `${c >= 0 ? '+' : ''}${c.toFixed(1)}¢`;
}

/** Momentum-weighted Up/Down mids at now + the same horizons as spot price prediction. */
export function buildContractProbProjectionGrid(params: {
  probUpPts: ProjectionTick[];
  probDownPts: ProjectionTick[];
  nowUp01: number | null;
  nowDown01: number | null;
  tapeNetPressure?: number | null;
  horizonSecs?: readonly number[];
}): ContractProbProjectionGrid | null {
  const nowNorm = normalizeBinaryFlexible(params.nowUp01, params.nowDown01);
  const nowUp = nowNorm.up;
  const nowDown = nowNorm.down;
  if (nowUp == null && nowDown == null) return null;

  const horizonSecs = params.horizonSecs ?? PRICE_PREDICTION_HORIZON_SECS;
  const horizonDefs = horizonSecs.map((sec) => ({ label: formatHorizonLabel(sec), sec }));

  const upProj = params.probUpPts.length >= 3
    ? computeMomentumProjection({
        pts: params.probUpPts,
        tapeNetPressure: params.tapeNetPressure,
        horizons: horizonDefs,
      })
    : null;
  const downProj = params.probDownPts.length >= 3
    ? computeMomentumProjection({
        pts: params.probDownPts,
        tapeNetPressure: params.tapeNetPressure != null ? -params.tapeNetPressure : null,
        horizons: horizonDefs,
      })
    : null;

  const cells: ContractProbHorizonCell[] = [
    {
      label: 'Now',
      horizonSec: 0,
      up01: nowUp,
      down01: nowDown,
      deltaUp01: null,
      deltaDown01: null,
      confidenceUp: 1,
      confidenceDown: 1,
    },
  ];

  for (const sec of horizonSecs) {
    const label = formatHorizonLabel(sec);
    const upPt = upProj?.points.find((p) => p.horizonSec === sec) ?? null;
    const downPt = downProj?.points.find((p) => p.horizonSec === sec) ?? null;
    const norm = normalizeBinaryFlexible(upPt?.price01 ?? null, downPt?.price01 ?? null);
    cells.push({
      label: `Projected ${label}`,
      horizonSec: sec,
      up01: norm.up,
      down01: norm.down,
      deltaUp01: norm.up != null && nowUp != null ? norm.up - nowUp : upPt?.delta01 ?? null,
      deltaDown01: norm.down != null && nowDown != null ? norm.down - nowDown : downPt?.delta01 ?? null,
      confidenceUp: upPt?.confidence ?? null,
      confidenceDown: downPt?.confidence ?? null,
    });
  }

  return { cells };
}
