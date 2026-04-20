import type { BookSnapshot } from './orderflowMetrics';
import type { SpotPoint } from './SpotLevelChart';

function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}

function windowSlice<T extends { t: number }>(pts: T[], windowMs: number): T[] {
  if (pts.length === 0) return [];
  const end = pts[pts.length - 1]!.t;
  const start = end - windowMs;
  return pts.filter((p) => p.t >= start);
}

function slopePerSec(pts: { t: number; v: number | null }[]): number | null {
  const xs = pts.filter((p) => typeof p.v === 'number' && Number.isFinite(p.v as number));
  if (xs.length < 2) return null;
  const a = xs[xs.length - 1]!;
  const b = xs[0]!;
  const dt = Math.max(1, (a.t - b.t) / 1000);
  return ((a.v as number) - (b.v as number)) / dt;
}

function avg(pts: number[]): number | null {
  if (pts.length === 0) return null;
  return pts.reduce((s, x) => s + x, 0) / pts.length;
}

export type RollingContext = {
  spotNow: number | null;
  ptb: number | null;
  dist: number | null;
  spotSlope1m: number | null;
  spotSlope15s: number | null;
  shareMidNow: number | null;
  shareMidSlope1m: number | null;
  imbalanceNow: number | null;
  churnNow: number | null;
  churnAvg1m: number | null;
};

export function buildRollingContext(params: {
  spotSeries: SpotPoint[];
  priceToBeat: number | null;
  flowSeries: BookSnapshot[];
}): RollingContext {
  const spotSeries = params.spotSeries;
  const spotNow = spotSeries.length ? spotSeries[spotSeries.length - 1]!.v : null;
  const ptb = params.priceToBeat;
  const dist = spotNow != null && ptb != null ? spotNow - ptb : null;

  const spot15 = windowSlice(spotSeries, 15_000);
  const spot1m = windowSlice(spotSeries, 60_000);
  const spotSlope15s = slopePerSec(spot15.map((p) => ({ t: p.t, v: p.v })));
  const spotSlope1m = slopePerSec(spot1m.map((p) => ({ t: p.t, v: p.v })));

  const flow = params.flowSeries;
  const flowNow = flow.length ? flow[flow.length - 1]! : null;
  const shareMidNow = flowNow?.mid ?? null;
  const imbNow = flowNow?.imbalance ?? null;
  const churnNow = flowNow?.churn ?? null;

  const flow1m = windowSlice(flow, 60_000);
  const shareMidSlope1m = slopePerSec(flow1m.map((p) => ({ t: p.t, v: p.mid })));
  const churnAvg1m = avg(flow1m.map((p) => p.churn).filter((x): x is number => typeof x === 'number' && Number.isFinite(x)));

  return {
    spotNow,
    ptb,
    dist,
    spotSlope1m,
    spotSlope15s,
    shareMidNow,
    shareMidSlope1m,
    imbalanceNow: imbNow != null ? clamp(imbNow, -1, 1) : null,
    churnNow,
    churnAvg1m,
  };
}

export function rollingContextText(ctx: RollingContext): string {
  const lines: string[] = [];
  lines.push('Rolling context (last 1–5 minutes):');
  lines.push(`- spot_now: ${ctx.spotNow ?? '—'}`);
  lines.push(`- price_to_beat: ${ctx.ptb ?? '—'}`);
  lines.push(`- distance_to_beat: ${ctx.dist ?? '—'} (spot - level)`);
  lines.push(`- spot_slope_15s_usd_per_s: ${ctx.spotSlope15s ?? '—'}`);
  lines.push(`- spot_slope_1m_usd_per_s: ${ctx.spotSlope1m ?? '—'}`);
  lines.push(`- share_mid_now: ${ctx.shareMidNow ?? '—'}`);
  lines.push(`- share_mid_slope_1m_per_s: ${ctx.shareMidSlope1m ?? '—'}`);
  lines.push(`- orderbook_imbalance_now: ${ctx.imbalanceNow ?? '—'} (depth-based)`);
  lines.push(`- orderbook_churn_now: ${ctx.churnNow ?? '—'} (snapshot speed)`);
  lines.push(`- orderbook_churn_avg_1m: ${ctx.churnAvg1m ?? '—'}`);
  return lines.join('\n');
}

