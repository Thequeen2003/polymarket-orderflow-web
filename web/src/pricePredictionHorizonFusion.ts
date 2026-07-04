import type { ContractProbHorizonCell, ContractProbProjectionGrid } from './contractProbProjection';
import { fmtContractCents, fmtContractDeltaCents } from './contractProbProjection';
import {
  formatPricePredictionDist,
  formatPricePredictionUsd,
  type PricePredictionProjection,
  type PricePredictionSignal,
  type PriceVsPtbReadout,
  type PriceVsPtbSide,
} from './pricePredictionSignal';

export type SettlementLane = 'up' | 'down' | 'at';

/** Chop-band zone vs confirmed UP/DOWN break lines (bandHi / bandLo). */
export type ConfirmedBandZone = 'above' | 'in_band' | 'below';

export type ConfirmedBandContext = {
  bandHi: number;
  bandLo: number;
};

export type HorizonFusionCell = {
  label: string;
  horizonSec: number;
  btcUsd: number;
  btcDeltaVsNowUsd: number | null;
  ptbUsd: number;
  gapVsPtbUsd: number;
  spotReadout: PriceVsPtbReadout;
  /** Position vs confirmed UP/DOWN break lines. */
  bandZone: ConfirmedBandZone | null;
  /** bandHi − price (≤ 0 when already confirmed above). */
  toConfirmedAboveUsd: number | null;
  /** price − bandLo (≤ 0 when already confirmed below). */
  toConfirmedBelowUsd: number | null;
  settlementLane: SettlementLane;
  up01: number | null;
  down01: number | null;
  deltaUp01: number | null;
  deltaDown01: number | null;
  contractFavored: SettlementLane;
  aligned: boolean | null;
  flatPinned: boolean;
  mismatchNote: string | null;
};

export function classifyConfirmedBandZone(
  priceUsd: number,
  bandHi: number,
  bandLo: number,
): ConfirmedBandZone {
  if (priceUsd > bandHi) return 'above';
  if (priceUsd < bandLo) return 'below';
  return 'in_band';
}

export function confirmedBandLabel(zone: ConfirmedBandZone): string {
  if (zone === 'above') return 'Confirmed Above';
  if (zone === 'below') return 'Confirmed Below';
  return 'In the Band';
}

export function confirmedBandDetail(
  btcUsd: number,
  bandHi: number,
  bandLo: number,
  zone: ConfirmedBandZone,
): string {
  if (zone === 'above') {
    return `${formatPricePredictionDist(btcUsd - bandHi)} past UP line`;
  }
  if (zone === 'below') {
    return `${formatPricePredictionDist(bandLo - btcUsd)} past DOWN line`;
  }
  const toAbove = bandHi - btcUsd;
  const toBelow = btcUsd - bandLo;
  return `${formatPricePredictionUsd(toAbove)} to above · ${formatPricePredictionUsd(toBelow)} to below`;
}

function bandFieldsForPrice(
  btcUsd: number,
  band: ConfirmedBandContext | null | undefined,
): Pick<HorizonFusionCell, 'bandZone' | 'toConfirmedAboveUsd' | 'toConfirmedBelowUsd'> {
  if (
    band == null ||
    !Number.isFinite(band.bandHi) ||
    !Number.isFinite(band.bandLo) ||
    band.bandHi <= band.bandLo
  ) {
    return { bandZone: null, toConfirmedAboveUsd: null, toConfirmedBelowUsd: null };
  }
  const zone = classifyConfirmedBandZone(btcUsd, band.bandHi, band.bandLo);
  return {
    bandZone: zone,
    toConfirmedAboveUsd: band.bandHi - btcUsd,
    toConfirmedBelowUsd: btcUsd - band.bandLo,
  };
}

function settlementLaneFromSpot(side: PriceVsPtbSide): SettlementLane {
  if (side === 'above') return 'up';
  if (side === 'below') return 'down';
  return 'at';
}

function contractFavoredLane(up01: number | null, down01: number | null): SettlementLane {
  if (up01 == null && down01 == null) return 'at';
  if (up01 != null && down01 == null) return up01 >= 0.5 ? 'up' : 'down';
  if (up01 == null && down01 != null) return down01 >= 0.5 ? 'down' : 'up';
  if (Math.abs(up01! - down01!) < 0.04) return 'at';
  return up01! >= down01! ? 'up' : 'down';
}

function lanesAligned(spot: SettlementLane, contract: SettlementLane): boolean | null {
  if (spot === 'at' || contract === 'at') return spot === contract ? true : null;
  return spot === contract;
}

function mismatchNote(
  spot: SettlementLane,
  contract: SettlementLane,
  upLabel: string,
  downLabel: string,
  up01: number | null,
  down01: number | null,
): string | null {
  const aligned = lanesAligned(spot, contract);
  if (aligned === true) return null;
  if (aligned === null) {
    if (spot === 'at') return `Spot near PTB — contracts lean ${contract === 'up' ? upLabel : downLabel}`;
    return null;
  }
  const spotName = spot === 'up' ? upLabel : downLabel;
  const contractName = contract === 'up' ? upLabel : downLabel;
  const upC = up01 != null ? fmtContractCents(up01) : '—';
  const downC = down01 != null ? fmtContractCents(down01) : '—';
  return `BTC settles ${spotName} but contracts favor ${contractName} (${upC} / ${downC})`;
}

function projectionRow(
  proj: PricePredictionProjection,
  signal: PricePredictionSignal,
  contract: ContractProbHorizonCell | null,
  upLabel: string,
  downLabel: string,
  confirmedBand: ConfirmedBandContext | null | undefined,
): HorizonFusionCell {
  const settlementLane = settlementLaneFromSpot(proj.projected.side);
  const contractFavored = contract
    ? contractFavoredLane(contract.up01, contract.down01)
    : 'at';
  const aligned = contract ? lanesAligned(settlementLane, contractFavored) : null;
  return {
    label: proj.label === 'Now' ? 'Now' : `Projected ${proj.label}`,
    horizonSec: proj.horizonSec,
    btcUsd: proj.projectedUsd,
    btcDeltaVsNowUsd: proj.deltaVsNowUsd,
    ptbUsd: signal.ptbUsd,
    gapVsPtbUsd: proj.projected.distUsd,
    spotReadout: proj.projected,
    ...bandFieldsForPrice(proj.projectedUsd, confirmedBand),
    settlementLane,
    up01: contract?.up01 ?? null,
    down01: contract?.down01 ?? null,
    deltaUp01: contract?.deltaUp01 ?? null,
    deltaDown01: contract?.deltaDown01 ?? null,
    contractFavored,
    aligned,
    flatPinned: contract?.flatPinned === true,
    mismatchNote: contract
      ? mismatchNote(settlementLane, contractFavored, upLabel, downLabel, contract.up01, contract.down01)
      : null,
  };
}

/** Merge spot BTC projections with contract mids per horizon. */
export function buildHorizonFusionGrid(args: {
  signal: PricePredictionSignal;
  contractProb?: ContractProbProjectionGrid | null;
  upLabel: string;
  downLabel: string;
  confirmedBand?: ConfirmedBandContext | null;
}): HorizonFusionCell[] {
  const { signal, contractProb, upLabel, downLabel, confirmedBand } = args;
  const contractBySec = new Map<number, ContractProbHorizonCell>();
  for (const c of contractProb?.cells ?? []) {
    contractBySec.set(c.horizonSec, c);
  }

  const nowContract = contractBySec.get(0) ?? null;
  const rows: HorizonFusionCell[] = [
    projectionRow(
      {
        label: 'Now',
        horizonSec: 0,
        projectedUsd: signal.spotUsd,
        deltaVsNowUsd: 0,
        projected: signal.now,
      },
      signal,
      nowContract,
      upLabel,
      downLabel,
      confirmedBand,
    ),
  ];

  for (const proj of signal.projections) {
    rows.push(
      projectionRow(proj, signal, contractBySec.get(proj.horizonSec) ?? null, upLabel, downLabel, confirmedBand),
    );
  }

  return rows;
}

export function formatHorizonFusionBtcLine(cell: HorizonFusionCell): string {
  const btc = formatPricePredictionUsd(cell.btcUsd);
  if (cell.btcDeltaVsNowUsd == null) return `BTC ${btc}`;
  return `BTC ${btc} (${formatPricePredictionDist(cell.btcDeltaVsNowUsd)} vs now)`;
}

export function formatHorizonFusionPtbLine(cell: HorizonFusionCell): string {
  return `PTB ${formatPricePredictionUsd(cell.ptbUsd)} · gap ${formatPricePredictionDist(cell.gapVsPtbUsd)}`;
}

export function formatHorizonFusionContractLine(
  cell: HorizonFusionCell,
  upLabel: string,
  downLabel: string,
): string | null {
  if (cell.up01 == null && cell.down01 == null) return null;
  const upPart =
    cell.up01 != null
      ? `${upLabel} ${fmtContractCents(cell.up01)}${
          cell.deltaUp01 != null ? ` (${fmtContractDeltaCents(cell.deltaUp01, { flatPinned: cell.flatPinned })})` : ''
        }`
      : null;
  const downPart =
    cell.down01 != null
      ? `${downLabel} ${fmtContractCents(cell.down01)}${
          cell.deltaDown01 != null ? ` (${fmtContractDeltaCents(cell.deltaDown01, { flatPinned: cell.flatPinned })})` : ''
        }`
      : null;
  return [upPart, downPart].filter(Boolean).join(' · ');
}

export function settlementLaneLabel(lane: SettlementLane, upLabel: string, downLabel: string): string {
  if (lane === 'up') return upLabel;
  if (lane === 'down') return downLabel;
  return 'AT PTB';
}
