export type SpotProjectionCell = {
  label: string;
  horizonSec: number;
  price: number;
  deltaUsd: number;
};

export type SpotProjectionGrid = {
  currentSpot: number;
  slopeUsdPerSec: number;
  /** 1m … 30m, one column per minute */
  minuteHorizons: SpotProjectionCell[];
  /** 5m, 15m, 30m, 1h, EOD (round bell when known) */
  longerHorizons: SpotProjectionCell[];
};

export const MINUTE_HORIZONS_MIN = Array.from({ length: 30 }, (_, i) => i + 1);
export const LONGER_HORIZONS_MIN = [5, 15, 30, 60] as const;

/** Linear extrapolation: current tick slope × horizon. Explanatory only. */
export function projectSpotLinear(spot: number, slopeUsdPerSec: number, horizonSec: number): number {
  return spot + slopeUsdPerSec * horizonSec;
}

function projectionCell(spotLast: number, slopeUsdPerSec: number, label: string, horizonSec: number): SpotProjectionCell {
  const price = projectSpotLinear(spotLast, slopeUsdPerSec, horizonSec);
  return { label, horizonSec, price, deltaUsd: price - spotLast };
}

export function buildSpotProjectionGrid(params: {
  spotLast: number;
  slopeUsdPerSec: number;
  endsInMs?: number | null;
}): SpotProjectionGrid | null {
  const { spotLast, slopeUsdPerSec, endsInMs } = params;
  if (!Number.isFinite(spotLast) || !Number.isFinite(slopeUsdPerSec)) return null;

  const minuteHorizons = MINUTE_HORIZONS_MIN.map((m) => projectionCell(spotLast, slopeUsdPerSec, `${m}m`, m * 60));

  const longerHorizons: SpotProjectionCell[] = LONGER_HORIZONS_MIN.map((m) =>
    projectionCell(spotLast, slopeUsdPerSec, m === 60 ? '1h' : `${m}m`, m * 60),
  );

  if (endsInMs != null && Number.isFinite(endsInMs) && endsInMs > 0) {
    longerHorizons.push(projectionCell(spotLast, slopeUsdPerSec, 'EOD', endsInMs / 1000));
  } else {
    longerHorizons.push({ label: 'EOD', horizonSec: 0, price: NaN, deltaUsd: NaN });
  }

  return { currentSpot: spotLast, slopeUsdPerSec, minuteHorizons, longerHorizons };
}
