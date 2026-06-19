import type { ReactElement, ReactNode } from 'react';
import {
  fmtContractCents,
  fmtContractDeltaCents,
  type ContractProbHorizonCell,
  type ContractProbProjectionGrid,
} from './contractProbProjection';
import { PredictionHorizonTimer } from './PredictionHorizonTimer';
import {
  formatPricePredictionDist,
  formatPricePredictionUsd,
  pricePredictionShellClass,
  pricePredictionTextClass,
  pricePredictionTone,
  spotProjectionHorizons,
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
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[10px] font-black uppercase tracking-wide ${shell}`}
    >
      {props.readout.side === 'above' ? '▲' : props.readout.side === 'below' ? '▼' : '◆'}
      {props.compact ? props.readout.label.replace(' PTB', '') : props.readout.label}
      <span className="font-bold tabular-nums opacity-90">{formatPricePredictionDist(props.readout.distUsd)}</span>
    </span>
  );
}

function HorizonSection(props: { title: string; hint?: string; children: ReactNode }): ReactElement {
  return (
    <div className="mt-3">
      <div className="text-[9px] font-black uppercase tracking-[0.14em] text-zinc-500">{props.title}</div>
      {props.hint ? <p className="mt-0.5 text-[9px] leading-snug text-zinc-600">{props.hint}</p> : null}
      <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">{props.children}</div>
    </div>
  );
}

function ContractProbHorizonBox(props: {
  cell: ContractProbHorizonCell;
  upLabel: string;
  downLabel: string;
}): ReactElement {
  const { cell, upLabel, downLabel } = props;
  const isNow = cell.horizonSec === 0;
  return (
    <div className="rounded-lg border border-zinc-800/55 bg-black/20 px-2.5 py-2">
      <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">{cell.label}</div>
      <div className="mt-2 space-y-2">
        <div>
          <div className="text-[8px] font-bold uppercase tracking-wide text-emerald-500/80">{upLabel}</div>
          <div className="font-mono text-sm font-bold tabular-nums text-emerald-200">{fmtContractCents(cell.up01)}</div>
          {!isNow ? (
            <div className="font-mono text-[10px] tabular-nums text-zinc-500">{fmtContractDeltaCents(cell.deltaUp01)} vs now</div>
          ) : null}
        </div>
        <div>
          <div className="text-[8px] font-bold uppercase tracking-wide text-rose-500/80">{downLabel}</div>
          <div className="font-mono text-sm font-bold tabular-nums text-rose-200">{fmtContractCents(cell.down01)}</div>
          {!isNow ? (
            <div className="font-mono text-[10px] tabular-nums text-zinc-500">{fmtContractDeltaCents(cell.deltaDown01)} vs now</div>
          ) : null}
        </div>
      </div>
      {!isNow && (cell.confidenceUp != null || cell.confidenceDown != null) ? (
        <div className="mt-2 text-[8px] text-zinc-600">
          conf{' '}
          {cell.confidenceUp != null ? `${upLabel} ${Math.round(cell.confidenceUp * 100)}%` : '—'}
          {cell.confidenceDown != null ? ` · ${downLabel} ${Math.round(cell.confidenceDown * 100)}%` : ''}
        </div>
      ) : null}
      <PredictionHorizonTimer horizonSec={cell.horizonSec} />
    </div>
  );
}

export function PricePredictionSignalCard(props: {
  signal: PricePredictionSignal;
  contractProb?: ContractProbProjectionGrid | null;
  upLabel: string;
  downLabel: string;
  compact?: boolean;
}): ReactElement {
  const { signal, contractProb, upLabel, downLabel, compact = false } = props;
  const spotHorizons = spotProjectionHorizons(signal);
  const projTone = pricePredictionTone(signal.projected.side);
  const shell = pricePredictionShellClass(projTone);
  const text = pricePredictionTextClass(projTone);

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

      <HorizonSection title="Underlying spot" hint="Linear spot extrapolation vs PTB">
        <div className="rounded-lg border border-zinc-800/55 bg-black/20 px-2.5 py-2">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Now</div>
          <div className="mt-1 font-mono text-sm font-bold tabular-nums text-zinc-100">
            {formatPricePredictionUsd(signal.spotUsd)}
          </div>
          <div className="mt-1.5">
            <SidePill readout={signal.now} />
          </div>
          <div className="mt-1 text-[9px] text-zinc-600">PTB {formatPricePredictionUsd(signal.ptbUsd)}</div>
          <PredictionHorizonTimer horizonSec={0} />
        </div>
        {spotHorizons.map((proj) => {
          const tone = pricePredictionTone(proj.projected.side);
          const priceCls = pricePredictionTextClass(tone);
          return (
            <div key={proj.horizonSec} className="rounded-lg border border-zinc-800/55 bg-black/20 px-2.5 py-2">
              <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Projected {proj.label}</div>
              <div className={`mt-1 font-mono text-sm font-bold tabular-nums ${priceCls}`}>
                {formatPricePredictionUsd(proj.projectedUsd)}
              </div>
              <div className="mt-1 font-mono text-[10px] tabular-nums text-indigo-300/80">
                {formatPricePredictionDist(proj.deltaVsNowUsd)} vs now
              </div>
              <div className="mt-1.5">
                <SidePill readout={proj.projected} />
              </div>
              <div className="mt-1 text-[9px] text-zinc-600">vs PTB {formatPricePredictionDist(proj.projected.distUsd)}</div>
              <PredictionHorizonTimer horizonSec={proj.horizonSec} />
            </div>
          );
        })}
      </HorizonSection>

      {contractProb ? (
        <HorizonSection
          title="Contract mids"
          hint="Momentum-weighted Up/Down implied probability — same horizons as spot"
        >
          {contractProb.cells.map((cell) => (
            <ContractProbHorizonBox key={cell.horizonSec} cell={cell} upLabel={upLabel} downLabel={downLabel} />
          ))}
        </HorizonSection>
      ) : null}
    </div>
  );
}
