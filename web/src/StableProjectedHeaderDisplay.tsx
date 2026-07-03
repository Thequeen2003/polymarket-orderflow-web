import { useRef, type ReactElement } from 'react';
import type { OutcomeProbDisplay, StableProjectedHeaderSnapshot } from './chartStableProjectedHeader';
import { stableProjectedHeaderKey } from './chartStableProjectedHeader';
import { fmtSpotUsd, fmtSpotUsdSigned } from './fmtSpotUsd';

function OutcomeChip(props: { side: OutcomeProbDisplay; variant: 'up' | 'down' }): ReactElement {
  const { side, variant } = props;
  const base =
    variant === 'up'
      ? 'border-emerald-800/45 bg-emerald-950/25 text-emerald-100'
      : 'border-rose-800/45 bg-rose-950/25 text-rose-100';
  const arrowClr =
    side.tone === 'up' ? 'text-emerald-400' : side.tone === 'down' ? 'text-rose-400' : 'text-zinc-500';

  return (
    <div
      className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 ${base}`}
      title={`${side.label} token mid on the book`}
    >
      <span className="text-[10px] font-black uppercase tracking-wide">{side.label}</span>
      <span className={`text-sm font-black ${arrowClr}`}>{side.arrow}</span>
      <span className="font-mono text-sm font-bold tabular-nums">{side.probCents ?? '—'}</span>
    </div>
  );
}

export function useStableProjectedHeaderDisplay(
  live: StableProjectedHeaderSnapshot | null,
): StableProjectedHeaderSnapshot | null {
  const ref = useRef<{ key: string; value: StableProjectedHeaderSnapshot } | null>(null);
  if (!live) return null;
  const key = stableProjectedHeaderKey(live);
  const prev = ref.current;
  if (prev?.key !== key) {
    ref.current = { key, value: live };
    return live;
  }
  if (
    prev.value.nowSpotUsd !== live.nowSpotUsd ||
    prev.value.up.probCents !== live.up.probCents ||
    prev.value.down.probCents !== live.down.probCents
  ) {
    ref.current = {
      key,
      value: {
        ...prev.value,
        nowSpotUsd: live.nowSpotUsd,
        deltaVsNowUsd: prev.value.projectedSpotUsd - live.nowSpotUsd,
        up: live.up,
        down: live.down,
      },
    };
  }
  return ref.current!.value;
}

function fmtDistFromPtb(n: number): string {
  return fmtSpotUsdSigned(n);
}

function ConfirmedBandChip(props: {
  kind: 'above' | 'below';
  priceUsd: number;
  ptbUsd: number;
}): ReactElement {
  const isAbove = props.kind === 'above';
  const distFromPtb = isAbove ? props.priceUsd - props.ptbUsd : props.ptbUsd - props.priceUsd;
  return (
    <div
      className={`flex flex-col rounded-lg border px-2 py-1 ${
        isAbove
          ? 'border-emerald-800/45 bg-emerald-950/25 text-emerald-100'
          : 'border-rose-800/45 bg-rose-950/25 text-rose-100'
      }`}
      title={
        isAbove
          ? `Confirmed UP break line — ${fmtDistFromPtb(distFromPtb)} from PTB (${fmtSpotUsd(props.ptbUsd)})`
          : `Confirmed DOWN break line — ${fmtDistFromPtb(-distFromPtb)} from PTB (${fmtSpotUsd(props.ptbUsd)})`
      }
    >
      <span
        className={`text-[8px] font-bold uppercase tracking-[0.12em] ${
          isAbove ? 'text-emerald-300/85' : 'text-rose-300/85'
        }`}
      >
        {isAbove ? 'Confirmed Above' : 'Confirmed Below'}
      </span>
      <span className="font-mono text-sm font-bold tabular-nums sm:text-base">
        {isAbove ? fmtDistFromPtb(distFromPtb) : fmtDistFromPtb(-distFromPtb)}
      </span>
      <span className="text-[8px] font-semibold uppercase tracking-[0.08em] text-zinc-500/90">from PTB</span>
      <span className="font-mono text-[10px] tabular-nums text-zinc-400">{fmtSpotUsd(props.priceUsd)}</span>
    </div>
  );
}

function NowBandDistanceChip(props: {
  nowUsd: number;
  bandHi: number;
  bandLo: number;
  ptbUsd: number;
}): ReactElement {
  const { nowUsd, bandHi, bandLo, ptbUsd } = props;
  const distFromPtb = nowUsd - ptbUsd;
  const toAbove = bandHi - nowUsd;
  const toBelow = nowUsd - bandLo;
  const aboveClear = toAbove <= 0;
  const belowClear = toBelow <= 0;

  return (
    <div
      className="flex flex-col rounded-lg border border-zinc-700/55 bg-zinc-900/40 px-2 py-1 text-zinc-100"
      title={`Now vs PTB ${fmtSpotUsd(ptbUsd)} · Confirmed above ${fmtSpotUsd(bandHi)} · Confirmed below ${fmtSpotUsd(bandLo)}`}
    >
      <span className="text-[8px] font-bold uppercase tracking-[0.12em] text-zinc-400">Now vs PTB</span>
      <span
        className={`font-mono text-sm font-bold tabular-nums sm:text-base ${
          distFromPtb > 0.005 ? 'text-emerald-300' : distFromPtb < -0.005 ? 'text-rose-300' : 'text-amber-200'
        }`}
      >
        {fmtDistFromPtb(distFromPtb)}
      </span>
      <div className="mt-0.5 flex flex-col gap-0.5">
        <span className="font-mono text-[10px] tabular-nums text-emerald-300/90">
          {aboveClear ? `↑ clear +${fmtSpotUsd(Math.abs(toAbove))}` : `↑ ${fmtSpotUsd(toAbove)} to above`}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-rose-300/90">
          {belowClear ? `↓ clear +${fmtSpotUsd(Math.abs(toBelow))}` : `↓ ${fmtSpotUsd(toBelow)} to below`}
        </span>
      </div>
    </div>
  );
}

export function StableProjectedHeaderDisplay(props: {
  snapshot: StableProjectedHeaderSnapshot;
  /** Raw spot for the headline — stable snapshot quantizes to reduce flicker on Proj/Δ only. */
  liveNowSpotUsd?: number | null;
  /** PTB separation band edges — shown beside UP/DOWN arrow chips. */
  confirmedBand?: { bandHi: number; bandLo: number; ptb: number } | null;
}): ReactElement {
  const { snapshot: s, confirmedBand, liveNowSpotUsd } = props;
  const nowUsd =
    liveNowSpotUsd != null && Number.isFinite(liveNowSpotUsd) ? liveNowSpotUsd : s.nowSpotUsd;
  const deltaVsNowUsd = s.projectedSpotUsd - nowUsd;
  const deltaUp = deltaVsNowUsd > 0.005;
  const deltaDown = deltaVsNowUsd < -0.005;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <div className="min-w-0">
        <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-400">Now</div>
        <div className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-zinc-50 sm:text-3xl">
          {fmtSpotUsd(nowUsd)}
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-indigo-300/80">
            Proj {s.horizonSec}s
          </span>
          <span className="font-mono text-sm font-semibold tabular-nums text-zinc-300 sm:text-base">
            {fmtSpotUsd(s.projectedSpotUsd)}
          </span>
          <span
            className={`text-xs font-semibold tabular-nums sm:text-sm ${
              deltaUp ? 'text-emerald-400' : deltaDown ? 'text-rose-400' : 'text-zinc-500'
            }`}
            title="Projected move vs current spot (stable, not tick noise)"
          >
            {fmtSpotUsdSigned(deltaVsNowUsd)}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <OutcomeChip side={s.up} variant="up" />
        <OutcomeChip side={s.down} variant="down" />
        {confirmedBand != null &&
        Number.isFinite(confirmedBand.bandHi) &&
        Number.isFinite(confirmedBand.bandLo) &&
        Number.isFinite(confirmedBand.ptb) ? (
          <>
            <ConfirmedBandChip kind="above" priceUsd={confirmedBand.bandHi} ptbUsd={confirmedBand.ptb} />
            <ConfirmedBandChip kind="below" priceUsd={confirmedBand.bandLo} ptbUsd={confirmedBand.ptb} />
            <NowBandDistanceChip
              nowUsd={nowUsd}
              bandHi={confirmedBand.bandHi}
              bandLo={confirmedBand.bandLo}
              ptbUsd={confirmedBand.ptb}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
