/** Distances and projection window for the Now Price Signals desk tab. */

export type PtbGeo = 'IN_BAND' | 'ABOVE' | 'BELOW';

export type ConfirmedEdgeGlance = {
  cleared: boolean;
  /** One line a trader reads first (e.g. "Already above" / "Still $19 below"). */
  primary: string;
  /** Supporting detail (line price or how far past). */
  secondary: string;
};

export type SpotBandGlance = {
  /** e.g. "Above PTB" / "In the chop band". */
  headline: string;
  /** One sentence under the headline. */
  subline: string;
  upBreak: ConfirmedEdgeGlance;
  downBreak: ConfirmedEdgeGlance;
};

function fmtUsdPlain(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/** Plain-language readout for confirmed above/below boxes and the Now window. */
export function buildSpotBandGlance(band: NowPriceBandDistances): SpotBandGlance {
  const upBreak = glanceConfirmedAbove(band);
  const downBreak = glanceConfirmedBelow(band);

  let headline: string;
  let subline: string;
  if (band.geo === 'ABOVE') {
    headline = 'Spot is above PTB';
    subline = upBreak.cleared
      ? 'UP break is confirmed — spot cleared the upper line.'
      : 'Spot is above PTB but has not cleared the UP break line yet.';
  } else if (band.geo === 'BELOW') {
    headline = 'Spot is below PTB';
    subline = downBreak.cleared
      ? 'DOWN break is confirmed — spot cleared the lower line.'
      : 'Spot is below PTB but has not cleared the DOWN break line yet.';
  } else {
    headline = 'Spot is in the chop band';
    subline = 'Between the lines — neither UP nor DOWN break is confirmed yet.';
  }

  return { headline, subline, upBreak, downBreak };
}

export function glanceConfirmedAbove(band: NowPriceBandDistances): ConfirmedEdgeGlance {
  const gap = band.toConfirmedAboveFromNow;
  if (gap <= 0.005) {
    return {
      cleared: true,
      primary: 'Already above',
      secondary: `${fmtUsdPlain(Math.abs(gap))} past the UP line`,
    };
  }
  return {
    cleared: false,
    primary: `Still ${fmtUsdPlain(gap)} below`,
    secondary: `UP line at ${fmtUsdPlain(band.bandHi)}`,
  };
}

export function glanceConfirmedBelow(band: NowPriceBandDistances): ConfirmedEdgeGlance {
  const gap = band.toConfirmedBelowFromNow;
  if (gap <= 0.005) {
    return {
      cleared: true,
      primary: 'Already below',
      secondary: `${fmtUsdPlain(Math.abs(gap))} past the DOWN line`,
    };
  }
  return {
    cleared: false,
    primary: `Still ${fmtUsdPlain(gap)} above`,
    secondary: `DOWN line at ${fmtUsdPlain(band.bandLo)}`,
  };
}

export type NowPriceBandDistances = {
  ptb: number;
  now: number;
  bandHi: number;
  bandLo: number;
  bandUsd: number;
  distNowFromPtb: number;
  /** bandHi − PTB (always ≥ 0). */
  distAboveFromPtb: number;
  /** PTB − bandLo (always ≥ 0). */
  distBelowFromPtb: number;
  /** bandHi − now (≤ 0 when already above confirmed). */
  toConfirmedAboveFromNow: number;
  /** now − bandLo (≤ 0 when already below confirmed). */
  toConfirmedBelowFromNow: number;
  geo: PtbGeo;
};

export type ProjectionNowCell = {
  label: string;
  horizonSec: number;
  price: number;
  deltaUsd: number;
  toConfirmedAbove: number;
  toConfirmedBelow: number;
  zone: 'above' | 'in_band' | 'below';
  /** 0–100 = share of current now→above gap closed; >100 = past confirmed above. */
  pctTowardAbove: number | null;
  /** 0–100 = share of current now→below gap closed; >100 = past confirmed below. */
  pctTowardBelow: number | null;
  /** Remaining $ as multiple of one PTB band width (distAboveFromPtb). */
  aboveInBands: number | null;
  /** Remaining $ as multiple of one PTB band width (distBelowFromPtb). */
  belowInBands: number | null;
};

/** Progress toward confirmed above/below from current spot (100% = at the line). */
export function projectionBandProgress(params: {
  now: number;
  price: number;
  bandHi: number;
  bandLo: number;
  distAboveFromPtb: number;
  distBelowFromPtb: number;
}): Pick<ProjectionNowCell, 'pctTowardAbove' | 'pctTowardBelow' | 'aboveInBands' | 'belowInBands'> {
  const { now, price, bandHi, bandLo, distAboveFromPtb, distBelowFromPtb } = params;
  const bandAbove = Math.max(distAboveFromPtb, 1e-6);
  const bandBelow = Math.max(distBelowFromPtb, 1e-6);

  const gapUp = bandHi - now;
  const gapDown = now - bandLo;
  const remainUp = bandHi - price;
  const remainDown = price - bandLo;

  let pctTowardAbove: number | null = null;
  if (gapUp > 0.005) {
    pctTowardAbove = ((gapUp - remainUp) / gapUp) * 100;
  } else if (remainUp <= 0.005) {
    pctTowardAbove = 100 + (Math.abs(remainUp) / bandAbove) * 100;
  } else {
    pctTowardAbove = 0;
  }

  let pctTowardBelow: number | null = null;
  if (gapDown > 0.005) {
    pctTowardBelow = ((gapDown - remainDown) / gapDown) * 100;
  } else if (remainDown <= 0.005) {
    pctTowardBelow = 100 + (Math.abs(remainDown) / bandBelow) * 100;
  } else {
    pctTowardBelow = 0;
  }

  return {
    pctTowardAbove,
    pctTowardBelow,
    aboveInBands: remainUp / bandAbove,
    belowInBands: remainDown / bandBelow,
  };
}

const NOW_WINDOW_HORIZONS: { label: string; sec: number }[] = [
  { label: '15s', sec: 15 },
  { label: '30s', sec: 30 },
  { label: '1m', sec: 60 },
  { label: '2m', sec: 120 },
  { label: '5m', sec: 300 },
  { label: '15m', sec: 900 },
  { label: '30m', sec: 1800 },
];

function classifyZone(price: number, bandHi: number, bandLo: number): 'above' | 'in_band' | 'below' {
  if (price > bandHi) return 'above';
  if (price < bandLo) return 'below';
  return 'in_band';
}

export function buildNowPriceBandDistances(params: {
  now: number;
  ptb: number;
  bandUsd: number;
}): NowPriceBandDistances | null {
  const { now, ptb, bandUsd } = params;
  if (!Number.isFinite(now) || !Number.isFinite(ptb) || !Number.isFinite(bandUsd) || bandUsd <= 0) return null;

  const bandHi = ptb + bandUsd;
  const bandLo = ptb - bandUsd;
  const distNowFromPtb = now - ptb;
  const inBand = Math.abs(distNowFromPtb) <= bandUsd;
  const geo: PtbGeo = inBand ? 'IN_BAND' : distNowFromPtb > 0 ? 'ABOVE' : 'BELOW';

  return {
    ptb,
    now,
    bandHi,
    bandLo,
    bandUsd,
    distNowFromPtb,
    distAboveFromPtb: bandHi - ptb,
    distBelowFromPtb: ptb - bandLo,
    toConfirmedAboveFromNow: bandHi - now,
    toConfirmedBelowFromNow: now - bandLo,
    geo,
  };
}

function buildProjectionCell(params: {
  label: string;
  horizonSec: number;
  now: number;
  price: number;
  bandHi: number;
  bandLo: number;
  distAboveFromPtb: number;
  distBelowFromPtb: number;
}): ProjectionNowCell {
  const { label, horizonSec, now, price, bandHi, bandLo, distAboveFromPtb, distBelowFromPtb } = params;
  const progress = projectionBandProgress({
    now,
    price,
    bandHi,
    bandLo,
    distAboveFromPtb,
    distBelowFromPtb,
  });
  return {
    label,
    horizonSec,
    price,
    deltaUsd: price - now,
    toConfirmedAbove: bandHi - price,
    toConfirmedBelow: price - bandLo,
    zone: classifyZone(price, bandHi, bandLo),
    ...progress,
  };
}

export function buildProjectionNowWindow(params: {
  now: number;
  slopeUsdPerSec: number;
  bandHi: number;
  bandLo: number;
  distAboveFromPtb: number;
  distBelowFromPtb: number;
  endsInMs?: number | null;
}): ProjectionNowCell[] {
  const { now, slopeUsdPerSec, bandHi, bandLo, distAboveFromPtb, distBelowFromPtb, endsInMs } = params;
  if (!Number.isFinite(now) || !Number.isFinite(slopeUsdPerSec)) return [];

  const cells: ProjectionNowCell[] = NOW_WINDOW_HORIZONS.map(({ label, sec }) => {
    const price = now + slopeUsdPerSec * sec;
    return buildProjectionCell({
      label,
      horizonSec: sec,
      now,
      price,
      bandHi,
      bandLo,
      distAboveFromPtb,
      distBelowFromPtb,
    });
  });

  if (endsInMs != null && Number.isFinite(endsInMs) && endsInMs > 0) {
    const sec = endsInMs / 1000;
    const price = now + slopeUsdPerSec * sec;
    cells.push(
      buildProjectionCell({
        label: 'EOD',
        horizonSec: sec,
        now,
        price,
        bandHi,
        bandLo,
        distAboveFromPtb,
        distBelowFromPtb,
      }),
    );
  }

  return cells;
}
