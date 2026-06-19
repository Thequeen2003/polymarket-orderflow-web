import { quantizeStableUsd } from './chartStableProjectedHeader';

export type PriceVsPtbSide = 'above' | 'below' | 'at';

export type PriceVsPtbReadout = {
  side: PriceVsPtbSide;
  distUsd: number;
  label: string;
};

export type PricePredictionProjection = {
  label: string;
  horizonSec: number;
  projectedUsd: number;
  deltaVsNowUsd: number;
  projected: PriceVsPtbReadout;
};

/** Default spot projection horizons shown in the price prediction card and headline. */
export const PRICE_PREDICTION_HORIZON_SECS = [30, 60, 300] as const;

export type PricePredictionSignal = {
  horizonSec: number;
  spotUsd: number;
  ptbUsd: number;
  projectedUsd: number;
  bandUsd: number;
  now: PriceVsPtbReadout;
  projected: PriceVsPtbReadout;
  /** 30s, 1m, and 5m linear spot projections vs PTB. */
  projections: PricePredictionProjection[];
  favoredLane: 'up' | 'down' | 'neutral';
  favoredLabel: string;
  /** Short callout for the card header, e.g. "Projected ABOVE PTB". */
  headline: string;
  /** One-line summary for compact rows. */
  summary: string;
};

export function formatHorizonLabel(horizonSec: number): string {
  if (horizonSec < 60) return `${horizonSec}s`;
  if (horizonSec % 60 === 0) return `${horizonSec / 60}m`;
  return `${horizonSec}s`;
}

/** Human time-frame label under each prediction box. */
export function formatHorizonTimeFrame(horizonSec: number): string {
  if (horizonSec <= 0) return 'Live · now';
  return `${formatHorizonLabel(horizonSec)} horizon`;
}

export function formatProjectionClockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatCountdownSec(totalSec: number): string {
  const sec = Math.max(0, Math.ceil(totalSec));
  if (sec < 60) return `0:${String(sec).padStart(2, '0')}`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (sec < 3600) return `${m}:${String(s).padStart(2, '0')}`;
  const h = Math.floor(sec / 3600);
  const rm = Math.floor((sec % 3600) / 60);
  return `${h}:${String(rm).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Countdown until the projection target from `nowMs` (rolling live horizon). */
export function projectionCountdownSec(horizonSec: number, nowMs: number): number {
  if (horizonSec <= 0) return 0;
  const targetMs = nowMs + horizonSec * 1000;
  return Math.max(0, Math.ceil((targetMs - nowMs) / 1000));
}

export function formatProjectionCountdown(horizonSec: number, nowMs: number): string {
  if (horizonSec <= 0) return '0:00';
  return formatCountdownSec(projectionCountdownSec(horizonSec, nowMs));
}

export function projectionTargetMs(horizonSec: number, nowMs: number): number {
  return horizonSec <= 0 ? nowMs : nowMs + horizonSec * 1000;
}

export function ptbDeadbandUsd(ptbUsd: number, bandUsd?: number | null): number {
  if (bandUsd != null && Number.isFinite(bandUsd) && bandUsd > 0) return bandUsd;
  return Math.max(Math.abs(ptbUsd) * 3e-5, 0.5);
}

export function sideVsPtb(priceUsd: number, ptbUsd: number, bandUsd?: number | null): PriceVsPtbReadout {
  const distUsd = priceUsd - ptbUsd;
  const band = ptbDeadbandUsd(ptbUsd, bandUsd);
  if (Math.abs(distUsd) <= band) {
    return { side: 'at', distUsd, label: 'AT PTB' };
  }
  if (distUsd > 0) {
    return { side: 'above', distUsd, label: 'ABOVE PTB' };
  }
  return { side: 'below', distUsd, label: 'BELOW PTB' };
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtUsdSigned(n: number): string {
  const s = n >= 0 ? '+' : '-';
  return `${s}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function buildPriceProjection(
  spotQ: number,
  slope: number,
  ptbUsd: number,
  bandUsd: number,
  horizonSec: number,
): PricePredictionProjection {
  const projectedUsd = quantizeStableUsd(spotQ + slope * horizonSec);
  return {
    label: formatHorizonLabel(horizonSec),
    horizonSec,
    projectedUsd,
    deltaVsNowUsd: projectedUsd - spotQ,
    projected: sideVsPtb(projectedUsd, ptbUsd, bandUsd),
  };
}

/** Linear spot projection vs PTB — now + horizon forecast with above/below labels. */
export function computePricePredictionSignal(params: {
  spotUsd: number;
  slopeUsdPerSec: number | null;
  ptbUsd: number;
  bandUsd?: number | null;
  horizonSec?: number;
  horizonSecs?: readonly number[];
  upLabel?: string;
  downLabel?: string;
}): PricePredictionSignal | null {
  const { spotUsd, ptbUsd } = params;
  if (!Number.isFinite(spotUsd) || !Number.isFinite(ptbUsd) || ptbUsd <= 0) return null;
  const horizonSec = params.horizonSec ?? 30;
  const horizonSecs = params.horizonSecs ?? PRICE_PREDICTION_HORIZON_SECS;
  const slope = params.slopeUsdPerSec != null && Number.isFinite(params.slopeUsdPerSec) ? params.slopeUsdPerSec : 0;
  const bandUsd = ptbDeadbandUsd(ptbUsd, params.bandUsd);
  const spotQ = quantizeStableUsd(spotUsd);
  const projectedUsd = quantizeStableUsd(spotUsd + slope * horizonSec);
  const now = sideVsPtb(spotQ, ptbUsd, bandUsd);
  const projected = sideVsPtb(projectedUsd, ptbUsd, bandUsd);
  const uniqueHorizons = [...new Set([horizonSec, ...horizonSecs])].sort((a, b) => a - b);
  const projections = uniqueHorizons.map((sec) => buildPriceProjection(spotQ, slope, ptbUsd, bandUsd, sec));

  const upLabel = (params.upLabel ?? 'UP').trim() || 'UP';
  const downLabel = (params.downLabel ?? 'DOWN').trim() || 'DOWN';
  let favoredLane: 'up' | 'down' | 'neutral' = 'neutral';
  let favoredLabel = 'No lean';
  if (projected.side === 'above') {
    favoredLane = 'up';
    favoredLabel = upLabel;
  } else if (projected.side === 'below') {
    favoredLane = 'down';
    favoredLabel = downLabel;
  }

  const headline =
    projected.side === 'at'
      ? `Projected AT PTB (${horizonSec}s)`
      : `Projected ${projected.label} (${horizonSec}s)`;

  const summary = buildPricePredictionSummary(now, projections);

  return {
    horizonSec,
    spotUsd: spotQ,
    ptbUsd,
    projectedUsd,
    bandUsd,
    now,
    projected,
    projections,
    favoredLane,
    favoredLabel,
    headline,
    summary,
  };
}

export function buildPricePredictionSummary(
  now: PriceVsPtbReadout,
  projections: PricePredictionProjection[],
): string {
  const parts = [`Now ${now.label} (${fmtUsdSigned(now.distUsd)})`];
  for (const p of projections) {
    parts.push(`${p.label} ${p.projected.label} (${fmtUsdSigned(p.projected.distUsd)})`);
  }
  return parts.join(' → ');
}

/** Spot projection horizons for display — falls back to the primary 30s row if needed. */
export function spotProjectionHorizons(signal: PricePredictionSignal): PricePredictionProjection[] {
  if (signal.projections?.length) return signal.projections;
  return [
    {
      label: formatHorizonLabel(signal.horizonSec),
      horizonSec: signal.horizonSec,
      projectedUsd: signal.projectedUsd,
      deltaVsNowUsd: signal.projectedUsd - signal.spotUsd,
      projected: signal.projected,
    },
  ];
}

export function pricePredictionTone(side: PriceVsPtbSide): 'up' | 'down' | 'flat' {
  if (side === 'above') return 'up';
  if (side === 'below') return 'down';
  return 'flat';
}

export function pricePredictionShellClass(tone: 'up' | 'down' | 'flat'): string {
  if (tone === 'up') return 'border-emerald-600/55 bg-emerald-950/35 ring-1 ring-emerald-500/20';
  if (tone === 'down') return 'border-rose-600/55 bg-rose-950/35 ring-1 ring-rose-500/20';
  return 'border-amber-700/45 bg-amber-950/25 ring-1 ring-amber-500/15';
}

export function pricePredictionTextClass(tone: 'up' | 'down' | 'flat'): string {
  if (tone === 'up') return 'text-emerald-200';
  if (tone === 'down') return 'text-rose-200';
  return 'text-amber-200';
}

export function formatPricePredictionDist(distUsd: number): string {
  return fmtUsdSigned(distUsd);
}

export function formatPricePredictionUsd(n: number): string {
  return fmtUsd(n);
}
