import { computeMomentumProjection, type ProjectionTick } from './momentumProjection';
import {
  PRICE_PREDICTION_HORIZON_SECS,
  formatHorizonLabel,
  type PricePredictionSignal,
  type PriceVsPtbSide,
} from './pricePredictionSignal';

export type ContractProbHorizonCell = {
  label: string;
  horizonSec: number;
  up01: number | null;
  down01: number | null;
  deltaUp01: number | null;
  deltaDown01: number | null;
  confidenceUp: number | null;
  confidenceDown: number | null;
  /** True when mid is pinned and projection shows no meaningful move. */
  flatPinned?: boolean;
};

export type ContractProbMarketState = 'open' | 'pinned_up' | 'pinned_down';

export type ContractProbReadout = {
  state: ContractProbMarketState;
  favoredLane: 'up' | 'down' | 'neutral';
  favoredMid01: number | null;
  /** Cents of room left before the 99¢ ceiling on the favored side. */
  roomCents: number | null;
  spotAligned: boolean | null;
  momentumFlat: boolean;
  note: string;
};

export type ContractProbProjectionGrid = {
  cells: ContractProbHorizonCell[];
  readout: ContractProbReadout;
};

const PIN_CEILING01 = 0.95;
const PIN_FLOOR01 = 0.05;
const FLAT_DELTA01 = 0.0008;

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

export function fmtContractDeltaCents(d01: number | null | undefined, opts?: { flatPinned?: boolean }): string {
  if (opts?.flatPinned) return 'pinned';
  if (d01 == null || !Number.isFinite(d01)) return '—';
  const c = d01 * 100;
  if (Math.abs(c) < 0.05) return 'flat';
  return `${c >= 0 ? '+' : ''}${c.toFixed(1)}¢`;
}

function ceilingRoomCents(mid01: number | null): number | null {
  if (mid01 == null || !Number.isFinite(mid01)) return null;
  return Math.max(0, Math.round((0.99 - mid01) * 1000) / 10);
}

export function analyzeContractProbReadout(args: {
  nowUp01: number | null;
  nowDown01: number | null;
  spotSide?: PriceVsPtbSide | null;
  projectedSpotSide?: PriceVsPtbSide | null;
  futureCells?: ContractProbHorizonCell[];
}): ContractProbReadout {
  const norm = normalizeBinaryFlexible(args.nowUp01, args.nowDown01);
  const up01 = norm.up;
  const down01 = norm.down;

  let state: ContractProbMarketState = 'open';
  let favoredLane: 'up' | 'down' | 'neutral' = 'neutral';
  let favoredMid01: number | null = null;

  if (down01 != null && down01 >= PIN_CEILING01) {
    state = 'pinned_down';
    favoredLane = 'down';
    favoredMid01 = down01;
  } else if (up01 != null && up01 <= PIN_FLOOR01) {
    state = 'pinned_down';
    favoredLane = 'down';
    favoredMid01 = down01;
  } else if (up01 != null && up01 >= PIN_CEILING01) {
    state = 'pinned_up';
    favoredLane = 'up';
    favoredMid01 = up01;
  } else if (down01 != null && down01 <= PIN_FLOOR01) {
    state = 'pinned_up';
    favoredLane = 'up';
    favoredMid01 = up01;
  } else if (up01 != null && down01 != null) {
    favoredLane = up01 >= down01 ? 'up' : 'down';
    favoredMid01 = favoredLane === 'up' ? up01 : down01;
  }

  const future = (args.futureCells ?? []).filter((c) => c.horizonSec > 0);
  const momentumFlat =
    future.length > 0 &&
    future.every(
      (c) =>
        Math.abs(c.deltaUp01 ?? 0) < FLAT_DELTA01 && Math.abs(c.deltaDown01 ?? 0) < FLAT_DELTA01,
    );

  const spotSide = args.spotSide ?? null;
  const spotAligned =
    state === 'pinned_down'
      ? spotSide === 'below' || spotSide === 'at'
      : state === 'pinned_up'
        ? spotSide === 'above' || spotSide === 'at'
        : null;

  const roomCents = state !== 'open' ? ceilingRoomCents(favoredMid01) : null;
  const favoredLabel = favoredLane === 'up' ? 'Up' : favoredLane === 'down' ? 'Down' : 'side';

  let note = '';
  if (state === 'pinned_down' && favoredMid01 != null) {
    const room = roomCents != null ? `~${roomCents.toFixed(1)}¢` : 'minimal';
    note = spotAligned
      ? `${favoredLabel} ${fmtContractCents(favoredMid01)} — spot below PTB; ${room} ceiling room. Fade mostly priced in.`
      : `${favoredLabel} ${fmtContractCents(favoredMid01)} pinned high but spot hasn't fully confirmed — watch mismatch.`;
    if (momentumFlat) note += ' Momentum flat — little contract repricing expected.';
  } else if (state === 'pinned_up' && favoredMid01 != null) {
    const room = roomCents != null ? `~${roomCents.toFixed(1)}¢` : 'minimal';
    note = spotAligned
      ? `${favoredLabel} ${fmtContractCents(favoredMid01)} — spot above PTB; ${room} ceiling room.`
      : `${favoredLabel} ${fmtContractCents(favoredMid01)} pinned high vs spot — possible lag.`;
    if (momentumFlat) note += ' Momentum flat at ceiling.';
  } else if (momentumFlat) {
    note = 'Contract mids flat across horizons — tape not repricing.';
  }

  return {
    state,
    favoredLane,
    favoredMid01,
    roomCents,
    spotAligned,
    momentumFlat,
    note,
  };
}

/** Fold live contract readout into the spot price-prediction card copy. */
export function enrichPricePredictionWithContracts(
  signal: PricePredictionSignal,
  grid: ContractProbProjectionGrid,
  upLabel: string,
  downLabel: string,
): PricePredictionSignal {
  const nowCell = grid.cells[0];
  const readout = analyzeContractProbReadout({
    nowUp01: nowCell?.up01 ?? null,
    nowDown01: nowCell?.down01 ?? null,
    spotSide: signal.now.side,
    projectedSpotSide: signal.projected.side,
    futureCells: grid.cells,
  });
  if (readout.state === 'open' && !readout.momentumFlat) return signal;

  const laneLabel = readout.favoredLane === 'up' ? upLabel : readout.favoredLane === 'down' ? downLabel : '';
  const primary = signal.projections[0];
  const driftUsd = primary?.deltaVsNowUsd ?? signal.projectedUsd - signal.spotUsd;
  const driftSign = driftUsd >= 0 ? '+' : '';
  const driftStr = `${driftSign}$${Math.abs(driftUsd).toFixed(1)}`;

  let headline = signal.headline;
  if (readout.state === 'pinned_down') {
    headline = `Spot fading below PTB · ${downLabel} pinned ${readout.favoredMid01 != null ? fmtContractCents(readout.favoredMid01) : 'high'}`;
  } else if (readout.state === 'pinned_up') {
    headline = `Spot holding above PTB · ${upLabel} pinned ${readout.favoredMid01 != null ? fmtContractCents(readout.favoredMid01) : 'high'}`;
  } else if (readout.momentumFlat) {
    headline = `${signal.headline} · contracts flat`;
  }

  const spotPart = `Spot ${signal.now.label.toLowerCase()} (${formatPricePredictionDist(signal.now.distUsd)}), ${signal.horizonSec}s drift ${driftStr}`;
  const contractPart =
    readout.note ||
    (laneLabel && readout.favoredMid01 != null
      ? `${laneLabel} ${fmtContractCents(readout.favoredMid01)}`
      : '');
  const summary = contractPart ? `${spotPart}. ${contractPart}` : spotPart;

  return { ...signal, headline, summary };
}

function formatPricePredictionDist(distUsd: number): string {
  const s = distUsd >= 0 ? '+' : '-';
  return `${s}$${Math.abs(distUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
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

  const readoutDraft = analyzeContractProbReadout({ nowUp01: nowUp, nowDown01: nowDown });
  const pinned = readoutDraft.state !== 'open';

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
    const deltaUp01 = norm.up != null && nowUp != null ? norm.up - nowUp : upPt?.delta01 ?? null;
    const deltaDown01 = norm.down != null && nowDown != null ? norm.down - nowDown : downPt?.delta01 ?? null;
    const flatPinned =
      pinned &&
      Math.abs(deltaUp01 ?? 0) < FLAT_DELTA01 &&
      Math.abs(deltaDown01 ?? 0) < FLAT_DELTA01;
    cells.push({
      label: `Projected ${label}`,
      horizonSec: sec,
      up01: norm.up,
      down01: norm.down,
      deltaUp01,
      deltaDown01,
      confidenceUp: flatPinned ? null : upPt?.confidence ?? null,
      confidenceDown: flatPinned ? null : downPt?.confidence ?? null,
      flatPinned,
    });
  }

  const readout = analyzeContractProbReadout({
    nowUp01: nowUp,
    nowDown01: nowDown,
    futureCells: cells,
  });

  return { cells, readout };
}
