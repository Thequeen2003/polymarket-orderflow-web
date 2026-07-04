import type { ReactElement, ReactNode } from 'react';
import {
  analyzeContractProbReadout,
  fmtContractCents,
  fmtContractDeltaCents,
  type ContractProbProjectionGrid,
  type ContractProbReadout,
} from './contractProbProjection';
import { PredictionHorizonTimer } from './PredictionHorizonTimer';
import {
  buildHorizonFusionGrid,
  confirmedBandDetail,
  confirmedBandLabel,
  formatHorizonFusionPtbLine,
  settlementLaneLabel,
  type ConfirmedBandContext,
  type ConfirmedBandZone,
  type HorizonFusionCell,
} from './pricePredictionHorizonFusion';
import {
  formatPricePredictionDist,
  formatPricePredictionUsd,
  pricePredictionShellClass,
  pricePredictionTextClass,
  pricePredictionTone,
  type PricePredictionSignal,
  type PriceVsPtbReadout,
} from './pricePredictionSignal';

function SidePill(props: { readout: PriceVsPtbReadout; compact?: boolean }): ReactElement {
  const tone = pricePredictionTone(props.readout.side);
  const shell =
    tone === 'up'
      ? 'border-emerald-700/50 bg-emerald-950/40 text-emerald-100'
      : tone === 'down'
        ? 'border-rose-700/50 bg-rose-950/40 text-rose-100'
        : 'border-amber-700/45 bg-amber-950/30 text-amber-100';
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[9px] font-black uppercase tracking-wide ${shell}`}>
      {props.readout.side === 'above' ? '▲' : props.readout.side === 'below' ? '▼' : '◆'}
      {props.compact ? props.readout.label.replace(' PTB', '') : props.readout.label}
      <span className="font-bold tabular-nums opacity-90">{formatPricePredictionDist(props.readout.distUsd)}</span>
    </span>
  );
}

function confirmedBandShell(zone: ConfirmedBandZone): string {
  if (zone === 'above') return 'border-emerald-600/55 bg-emerald-950/35 text-emerald-100';
  if (zone === 'below') return 'border-rose-600/55 bg-rose-950/35 text-rose-100';
  return 'border-amber-600/50 bg-amber-950/30 text-amber-100';
}

function ConfirmedBandBadge(props: {
  zone: ConfirmedBandZone;
  btcUsd: number;
  bandHi: number;
  bandLo: number;
  compact?: boolean;
}): ReactElement {
  const { zone, btcUsd, bandHi, bandLo, compact = false } = props;
  const detail = confirmedBandDetail(btcUsd, bandHi, bandLo, zone);
  return (
    <div className={`rounded-lg border px-2 py-1 ${confirmedBandShell(zone)}`}>
      <div className="text-[9px] font-black uppercase tracking-[0.12em]">{confirmedBandLabel(zone)}</div>
      {!compact ? (
        <div className="mt-0.5 font-mono text-[10px] font-semibold tabular-nums opacity-90">{detail}</div>
      ) : null}
    </div>
  );
}

function HorizonSection(props: { title: string; hint?: string; children: ReactNode }): ReactElement {
  return (
    <div className="mt-3">
      <div className="text-[9px] font-black uppercase tracking-[0.14em] text-zinc-500">{props.title}</div>
      {props.hint ? <p className="mt-0.5 text-[9px] leading-snug text-zinc-600">{props.hint}</p> : null}
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">{props.children}</div>
    </div>
  );
}

function UsdDeltaChip(props: { deltaUsd: number | null; muted?: boolean }): ReactElement | null {
  const { deltaUsd, muted = false } = props;
  if (deltaUsd == null || !Number.isFinite(deltaUsd)) return null;
  if (Math.abs(deltaUsd) < 0.005) {
    return <span className="font-mono text-[11px] font-bold tabular-nums text-zinc-500">→ flat</span>;
  }
  const up = deltaUsd > 0;
  const cls = muted
    ? 'text-zinc-400'
    : up
      ? 'text-emerald-300'
      : 'text-rose-300';
  return (
    <span className={`inline-flex items-center gap-0.5 font-mono text-[10px] font-black tabular-nums ${cls}`}>
      <span aria-hidden>{up ? '▲' : '▼'}</span>
      {formatPricePredictionDist(deltaUsd)}
      <span className="text-[8px] font-bold uppercase tracking-wide opacity-80">vs now</span>
    </span>
  );
}

function ContractCentsDelta(props: {
  delta01: number | null;
  lane: 'up' | 'down';
  flatPinned?: boolean;
  compact?: boolean;
}): ReactElement | null {
  const { delta01, lane, flatPinned = false, compact = false } = props;
  const size = compact ? 'text-[9px]' : 'text-[11px]';
  if (flatPinned) {
    return <span className={`font-mono font-bold uppercase tracking-wide text-zinc-500 ${size}`}>pinned</span>;
  }
  const text = fmtContractDeltaCents(delta01, { flatPinned });
  if (text === '—') return null;
  if (text === 'flat') {
    return <span className={`font-mono font-bold text-zinc-500 ${size}`}>→ flat</span>;
  }
  const up = (delta01 ?? 0) > 0;
  const favorable = (lane === 'up' && up) || (lane === 'down' && !up);
  const cls = favorable
    ? lane === 'up'
      ? 'text-emerald-300'
      : 'text-rose-300'
    : lane === 'up'
      ? 'text-rose-300/90'
      : 'text-emerald-300/80';
  return (
    <span className={`inline-flex items-center gap-0.5 font-mono font-bold tabular-nums ${size} ${cls}`}>
      <span aria-hidden>{up ? '▲' : '▼'}</span>
      {text}
    </span>
  );
}

function ContractMidsTile(props: {
  upLabel: string;
  downLabel: string;
  up01: number | null;
  down01: number | null;
  deltaUp01: number | null;
  deltaDown01: number | null;
  flatPinned?: boolean;
  showDelta: boolean;
  aligned?: boolean | null;
  mismatchNote?: string | null;
}): ReactElement {
  const {
    upLabel,
    downLabel,
    up01,
    down01,
    deltaUp01,
    deltaDown01,
    flatPinned = false,
    showDelta,
    aligned,
    mismatchNote,
  } = props;

  const lanes: Array<{
    label: string;
    lane: 'up' | 'down';
    mid01: number | null;
    delta01: number | null;
  }> = [
    { label: upLabel, lane: 'up', mid01: up01, delta01: deltaUp01 },
    { label: downLabel, lane: 'down', mid01: down01, delta01: deltaDown01 },
  ];

  return (
    <div className="rounded-lg border border-indigo-800/35 bg-indigo-950/20 px-2 py-1.5">
      <div className="text-[8px] font-black uppercase tracking-[0.14em] text-indigo-300/85">Contract mids</div>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        {lanes.map((row) => {
          if (row.mid01 == null) return null;
          const labelCls = row.lane === 'up' ? 'text-emerald-400/95' : 'text-rose-400/95';
          const priceCls = row.lane === 'up' ? 'text-emerald-100' : 'text-rose-100';
          const shell =
            row.lane === 'up'
              ? 'border-emerald-800/35 bg-emerald-950/20'
              : 'border-rose-800/35 bg-rose-950/20';
          return (
            <div key={row.lane} className={`min-w-0 rounded-md border px-1.5 py-1 ${shell}`}>
              <div className={`truncate text-[8px] font-black uppercase tracking-[0.1em] ${labelCls}`}>{row.label}</div>
              <div className={`mt-0.5 font-mono text-[13px] font-black tabular-nums leading-none ${priceCls}`}>
                {fmtContractCents(row.mid01)}
              </div>
              <div className="mt-0.5 min-h-[12px]">
                {showDelta ? (
                  <ContractCentsDelta
                    delta01={row.delta01}
                    lane={row.lane}
                    flatPinned={flatPinned}
                    compact
                  />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {aligned === true ? (
        <div className="mt-1.5 text-[8px] font-semibold leading-snug text-emerald-300/90">✓ BTC path matches contract lean</div>
      ) : mismatchNote ? (
        <div className="mt-1.5 text-[8px] font-semibold leading-snug text-amber-200/95">⚠ {mismatchNote}</div>
      ) : null}
    </div>
  );
}

function BtcPriceBlock(props: { cell: HorizonFusionCell }): ReactElement {
  const { cell } = props;
  const isNow = cell.horizonSec === 0;
  const spotCls = pricePredictionTextClass(pricePredictionTone(cell.spotReadout.side));

  return (
    <div className="mt-1 space-y-0.5">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0">
        <span className="text-[8px] font-black uppercase tracking-[0.12em] text-amber-300/85">BTC</span>
        <span className="font-mono text-[13px] font-black tabular-nums leading-none text-zinc-50 sm:text-sm">
          {formatPricePredictionUsd(cell.btcUsd)}
        </span>
      </div>
      {!isNow ? <UsdDeltaChip deltaUsd={cell.btcDeltaVsNowUsd} /> : null}
      <div className={`font-mono text-[10px] font-semibold tabular-nums leading-snug ${spotCls}`}>
        {formatHorizonFusionPtbLine(cell)}
      </div>
    </div>
  );
}

function ContractPinnedBanner(props: {
  readout: ContractProbReadout;
  upLabel: string;
  downLabel: string;
}): ReactElement {
  const { readout, upLabel, downLabel } = props;
  const laneLabel = readout.favoredLane === 'up' ? upLabel : readout.favoredLane === 'down' ? downLabel : '—';
  const shell =
    readout.favoredLane === 'up'
      ? 'border-emerald-600/45 bg-emerald-950/30'
      : readout.favoredLane === 'down'
        ? 'border-rose-600/45 bg-rose-950/30'
        : 'border-zinc-700/45 bg-zinc-950/30';
  return (
    <div className={`mt-2 rounded-lg border px-2.5 py-2 ${shell}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[9px] font-black uppercase tracking-wide text-zinc-400">Pinned</span>
        <span className="font-mono text-sm font-bold tabular-nums text-zinc-100">
          {laneLabel} {readout.favoredMid01 != null ? fmtContractCents(readout.favoredMid01) : '—'}
        </span>
        {readout.roomCents != null ? (
          <span className="rounded-md border border-amber-600/40 bg-amber-950/35 px-1.5 py-0.5 font-mono text-[10px] font-bold tabular-nums text-amber-100">
            {readout.roomCents.toFixed(1)}¢ room
          </span>
        ) : null}
        {readout.spotAligned === true ? (
          <span className="text-[9px] font-semibold text-emerald-300/90">✓ spot aligned</span>
        ) : readout.spotAligned === false ? (
          <span className="text-[9px] font-semibold text-amber-300/90">⚠ spot mismatch</span>
        ) : null}
      </div>
      {readout.note ? <p className="mt-1.5 text-[10px] leading-snug text-zinc-300">{readout.note}</p> : null}
    </div>
  );
}

function HorizonFusionBox(props: {
  cell: HorizonFusionCell;
  upLabel: string;
  downLabel: string;
  confirmedBand: ConfirmedBandContext | null;
  compact?: boolean;
}): ReactElement | null {
  const { cell, upLabel, downLabel, confirmedBand, compact = false } = props;
  const isNow = cell.horizonSec === 0;
  if (compact && !isNow && cell.flatPinned) return null;

  const settleName = settlementLaneLabel(cell.settlementLane, upLabel, downLabel);
  const hasContracts = cell.up01 != null || cell.down01 != null;

  return (
    <div className="rounded-lg border border-zinc-800/55 bg-black/20 px-2 py-2 sm:px-2.5">
      <div className="text-[8px] font-semibold uppercase tracking-wide text-zinc-500">
        {isNow ? 'Live · now' : cell.label}
      </div>

      {hasContracts ? (
        <div className="mt-1.5">
          <ContractMidsTile
            upLabel={upLabel}
            downLabel={downLabel}
            up01={cell.up01}
            down01={cell.down01}
            deltaUp01={cell.deltaUp01}
            deltaDown01={cell.deltaDown01}
            flatPinned={cell.flatPinned}
            showDelta={!isNow}
            aligned={cell.aligned}
            mismatchNote={cell.mismatchNote}
          />
        </div>
      ) : null}

      <BtcPriceBlock cell={cell} />

      <div className="mt-2 space-y-1.5">
        {cell.bandZone != null && confirmedBand ? (
          <ConfirmedBandBadge
            zone={cell.bandZone}
            btcUsd={cell.btcUsd}
            bandHi={confirmedBand.bandHi}
            bandLo={confirmedBand.bandLo}
          />
        ) : null}
        <div className="flex flex-wrap items-center gap-1">
          <SidePill readout={cell.spotReadout} compact />
          <span className="text-[8px] font-bold uppercase tracking-wide text-zinc-500">→ settles</span>
          <span
            className={`rounded border px-1 py-0.5 text-[8px] font-black uppercase tracking-wide ${
              cell.settlementLane === 'up'
                ? 'border-emerald-700/50 bg-emerald-950/40 text-emerald-100'
                : cell.settlementLane === 'down'
                  ? 'border-rose-700/50 bg-rose-950/40 text-rose-100'
                  : 'border-amber-700/45 bg-amber-950/30 text-amber-100'
            }`}
          >
            {settleName}
          </span>
        </div>
      </div>

      <PredictionHorizonTimer horizonSec={cell.horizonSec} />
    </div>
  );
}

export function PricePredictionSignalCard(props: {
  signal: PricePredictionSignal;
  contractProb?: ContractProbProjectionGrid | null;
  upLabel: string;
  downLabel: string;
  confirmedBand?: ConfirmedBandContext | null;
  compact?: boolean;
}): ReactElement {
  const { signal, contractProb, upLabel, downLabel, confirmedBand = null, compact = false } = props;
  const projTone = pricePredictionTone(signal.projected.side);
  const shell = pricePredictionShellClass(projTone);
  const text = pricePredictionTextClass(projTone);
  const contractReadout =
    contractProb != null
      ? analyzeContractProbReadout({
          nowUp01: contractProb.cells[0]?.up01 ?? null,
          nowDown01: contractProb.cells[0]?.down01 ?? null,
          spotSide: signal.now.side,
          projectedSpotSide: signal.projected.side,
          futureCells: contractProb.cells,
        })
      : null;

  const fusionRows = buildHorizonFusionGrid({
    signal,
    contractProb,
    upLabel,
    downLabel,
    confirmedBand,
  });

  const nowBandZone = fusionRows[0]?.bandZone ?? null;

  if (compact) {
    return (
      <div className={`rounded-lg border px-2.5 py-2 ${shell}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-[10px] font-black uppercase tracking-wide ${text}`}>{signal.headline}</span>
          <SidePill readout={signal.now} compact />
          <span className="text-zinc-600">→</span>
          <SidePill readout={signal.projected} compact />
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-xl border px-3 py-3 sm:px-4 ${shell}`}>
      <div className="text-[9px] font-black uppercase tracking-[0.14em] text-indigo-300/85">Price prediction</div>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={`text-xl font-black tracking-tight sm:text-2xl ${text}`}>{signal.headline}</div>
          <p className="mt-1 text-[11px] leading-snug text-zinc-400">{signal.summary}</p>
          {nowBandZone != null && confirmedBand ? (
            <div className="mt-2">
              <ConfirmedBandBadge
                zone={nowBandZone}
                btcUsd={signal.spotUsd}
                bandHi={confirmedBand.bandHi}
                bandLo={confirmedBand.bandLo}
                compact
              />
            </div>
          ) : null}
        </div>
        {signal.favoredLane !== 'neutral' ? (
          <div
            className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-center ${
              signal.favoredLane === 'up'
                ? 'border-emerald-700/45 bg-emerald-950/30'
                : 'border-rose-700/45 bg-rose-950/30'
            }`}
          >
            <div className="text-[8px] font-semibold uppercase tracking-wide text-zinc-500">Settlement lean</div>
            <div
              className={`mt-0.5 text-sm font-black uppercase ${
                signal.favoredLane === 'up' ? 'text-emerald-200' : 'text-rose-200'
              }`}
            >
              {signal.favoredLane === 'up' ? upLabel : downLabel}
            </div>
          </div>
        ) : null}
      </div>

      <HorizonSection
        title="BTC vs PTB vs contracts"
        hint="Projected BTC price, confirmed above/below band lines, settlement side, and contract mids at each horizon"
      >
        {contractReadout && contractReadout.state !== 'open' ? (
          <div className="col-span-1 sm:col-span-2 xl:col-span-4">
            <ContractPinnedBanner readout={contractReadout} upLabel={upLabel} downLabel={downLabel} />
          </div>
        ) : null}
        {fusionRows.map((cell) => (
          <HorizonFusionBox
            key={cell.horizonSec}
            cell={cell}
            upLabel={upLabel}
            downLabel={downLabel}
            confirmedBand={confirmedBand}
            compact={contractReadout?.momentumFlat === true}
          />
        ))}
      </HorizonSection>
    </div>
  );
}
