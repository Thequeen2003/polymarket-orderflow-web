/**
 * 30-day hourly spot projection grid — linear extrapolation from latest tick slope.
 * Explanatory only; not a forecast guarantee.
 */

import { sideVsPtb, type PriceVsPtbSide } from './pricePredictionSignal';
import { projectSpotLinear } from './spotPriceProjection';

export const PROJECTION_HOURS_30D = 30 * 24;

export type HourlyProjectionRow = {
  hourIndex: number;
  dayIndex: number;
  hourInDay: number;
  horizonSec: number;
  targetMs: number;
  price: number;
  deltaUsd: number;
  timeLabel: string;
  ptbSide: PriceVsPtbSide | null;
  ptbDistUsd: number | null;
};

export type DailyProjectionSummary = {
  dayIndex: number;
  dateLabel: string;
  hourCount: number;
  openPrice: number;
  closePrice: number;
  highPrice: number;
  lowPrice: number;
  deltaOpenVsNowUsd: number;
  deltaCloseVsNowUsd: number;
  ptbSideAtClose: PriceVsPtbSide | null;
};

export type SpotProjection30dGrid = {
  generatedAtMs: number;
  currentSpot: number;
  slopeUsdPerSec: number;
  slopeUsdPerMin: number;
  slopeUsdPerHour: number;
  ptbUsd: number | null;
  hourlyRows: HourlyProjectionRow[];
  dailySummaries: DailyProjectionSummary[];
};

function fmtHourLabel(targetMs: number): string {
  return new Date(targetMs).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function fmtDayLabel(targetMs: number): string {
  return new Date(targetMs).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function build30DayHourlySpotProjections(params: {
  spotLast: number;
  slopeUsdPerSec: number;
  nowMs?: number;
  ptbUsd?: number | null;
  bandUsd?: number | null;
  hourCount?: number;
}): SpotProjection30dGrid | null {
  const { spotLast, slopeUsdPerSec, ptbUsd, bandUsd } = params;
  if (!Number.isFinite(spotLast) || !Number.isFinite(slopeUsdPerSec)) return null;

  const nowMs = params.nowMs ?? Date.now();
  const hours = Math.min(PROJECTION_HOURS_30D, Math.max(1, params.hourCount ?? PROJECTION_HOURS_30D));

  const hourlyRows: HourlyProjectionRow[] = [];
  for (let h = 1; h <= hours; h++) {
    const horizonSec = h * 3600;
    const targetMs = nowMs + horizonSec * 1000;
    const price = projectSpotLinear(spotLast, slopeUsdPerSec, horizonSec);
    const dayIndex = Math.ceil(h / 24);
    const hourInDay = (h - 1) % 24;
    const ptbRead =
      ptbUsd != null && Number.isFinite(ptbUsd)
        ? sideVsPtb(price, ptbUsd, bandUsd)
        : null;
    hourlyRows.push({
      hourIndex: h,
      dayIndex,
      hourInDay,
      horizonSec,
      targetMs,
      price,
      deltaUsd: price - spotLast,
      timeLabel: fmtHourLabel(targetMs),
      ptbSide: ptbRead?.side ?? null,
      ptbDistUsd: ptbRead?.distUsd ?? null,
    });
  }

  const dailySummaries: DailyProjectionSummary[] = [];
  const dayCount = Math.ceil(hours / 24);
  for (let d = 1; d <= dayCount; d++) {
    const dayRows = hourlyRows.filter((r) => r.dayIndex === d);
    if (dayRows.length === 0) continue;
    const prices = dayRows.map((r) => r.price);
    const open = dayRows[0]!;
    const close = dayRows[dayRows.length - 1]!;
    const ptbClose =
      ptbUsd != null && Number.isFinite(ptbUsd)
        ? sideVsPtb(close.price, ptbUsd, bandUsd)
        : null;
    dailySummaries.push({
      dayIndex: d,
      dateLabel: fmtDayLabel(open.targetMs),
      hourCount: dayRows.length,
      openPrice: open.price,
      closePrice: close.price,
      highPrice: Math.max(...prices),
      lowPrice: Math.min(...prices),
      deltaOpenVsNowUsd: open.price - spotLast,
      deltaCloseVsNowUsd: close.price - spotLast,
      ptbSideAtClose: ptbClose?.side ?? null,
    });
  }

  return {
    generatedAtMs: nowMs,
    currentSpot: spotLast,
    slopeUsdPerSec,
    slopeUsdPerMin: slopeUsdPerSec * 60,
    slopeUsdPerHour: slopeUsdPerSec * 3600,
    ptbUsd: ptbUsd != null && Number.isFinite(ptbUsd) ? ptbUsd : null,
    hourlyRows,
    dailySummaries,
  };
}
