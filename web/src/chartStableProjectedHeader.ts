/** Stable chart header: 30s projected spot + UP/DOWN prob with direction arrows. */

export type OutcomeProbDisplay = {
  label: string;
  probCents: string | null;
  arrow: '↑' | '↓' | '→';
  tone: 'up' | 'down' | 'flat';
};

export type StableProjectedHeaderSnapshot = {
  horizonSec: number;
  nowSpotUsd: number;
  projectedSpotUsd: number;
  deltaVsNowUsd: number;
  up: OutcomeProbDisplay;
  down: OutcomeProbDisplay;
};

function fmtProbCents(prob01: number | null | undefined): string | null {
  if (prob01 == null || !Number.isFinite(prob01) || prob01 <= 0 || prob01 >= 1) return null;
  const c = prob01 * 100;
  return c >= 10 ? `${c.toFixed(1)}¢` : `${c.toFixed(2)}¢`;
}

/** Quantize projected spot for the headline — keep cent precision on BTC/ETH. */
export function quantizeStableUsd(n: number): number {
  if (!Number.isFinite(n)) return n;
  const abs = Math.abs(n);
  const step = abs >= 10_000 ? 0.05 : 0.01;
  return Math.round(n / step) * step;
}

function outcomeArrow(favorable: boolean, flat: boolean): { arrow: '↑' | '↓' | '→'; tone: 'up' | 'down' | 'flat' } {
  if (flat) return { arrow: '→', tone: 'flat' };
  return favorable ? { arrow: '↑', tone: 'up' } : { arrow: '↓', tone: 'down' };
}

/** Linear spot projection + outcome prob readout for the chart title row. */
export function computeStableProjectedHeader(params: {
  spotLast: number;
  slopeUsdPerSec: number | null;
  ptb: number | null;
  lastProbUp: number | null;
  lastProbDown: number | null;
  upLabel: string;
  downLabel: string;
  horizonSec?: number;
}): StableProjectedHeaderSnapshot | null {
  const { spotLast, slopeUsdPerSec, ptb, lastProbUp, lastProbDown, upLabel, downLabel } = params;
  if (!Number.isFinite(spotLast)) return null;
  const horizonSec = params.horizonSec ?? 30;
  const slope = slopeUsdPerSec != null && Number.isFinite(slopeUsdPerSec) ? slopeUsdPerSec : 0;
  const rawProjected = spotLast + slope * horizonSec;
  const projectedSpotUsd = quantizeStableUsd(rawProjected);
  const nowSpotUsd = quantizeStableUsd(spotLast);
  const deltaVsNowUsd = projectedSpotUsd - nowSpotUsd;

  let upFav = false;
  let downFav = false;
  let flat = true;
  if (ptb != null && Number.isFinite(ptb)) {
    const d = projectedSpotUsd - ptb;
    const band = Math.max(Math.abs(ptb) * 3e-5, 0.5);
    flat = Math.abs(d) <= band;
    upFav = d > band;
    downFav = d < -band;
  } else if (Math.abs(deltaVsNowUsd) > 0.05) {
    flat = false;
    upFav = deltaVsNowUsd > 0;
    downFav = deltaVsNowUsd < 0;
  }

  const upArrow = outcomeArrow(upFav, flat);
  const downArrow = outcomeArrow(downFav, flat);

  return {
    horizonSec,
    nowSpotUsd,
    projectedSpotUsd,
    deltaVsNowUsd,
    up: { label: upLabel, probCents: fmtProbCents(lastProbUp), ...upArrow },
    down: { label: downLabel, probCents: fmtProbCents(lastProbDown), ...downArrow },
  };
}

export function stableProjectedHeaderKey(s: StableProjectedHeaderSnapshot): string {
  return [
    s.horizonSec,
    s.nowSpotUsd.toFixed(2),
    s.projectedSpotUsd.toFixed(2),
    s.deltaVsNowUsd.toFixed(2),
    s.up.probCents ?? '-',
    s.down.probCents ?? '-',
    s.up.arrow,
    s.down.arrow,
  ].join('|');
}
