import type { DataTradeRow } from './lib/api';
import type { BookSnapshot } from './orderflowMetrics';

export function tapeDirectionalStats(
  rows: DataTradeRow[],
  upToken: string | null,
  downToken: string | null,
): { perMin: number; upFrac: number; dir: number } {
  if (rows.length < 2) return { perMin: 0, upFrac: 0.5, dir: 0 };
  const ts = rows.map((r) => r.timestamp).filter((t) => Number.isFinite(t) && t > 0);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const dtMin = Math.max(1e-6, (t1 - t0) / 60);
  const perMin = rows.length / dtMin;
  if (!upToken || !downToken) return { perMin, upFrac: 0.5, dir: 0 };

  let upScore = 0;
  let dnScore = 0;
  for (const r of rows) {
    const a = r.asset ?? '';
    if (!a) continue;
    if (a === upToken) {
      if (r.side === 'BUY') upScore += 1;
      else if (r.side === 'SELL') dnScore += 1;
    } else if (a === downToken) {
      if (r.side === 'BUY') dnScore += 1;
      else if (r.side === 'SELL') upScore += 1;
    }
  }
  const tot = upScore + dnScore;
  const upFrac = tot > 0 ? upScore / tot : 0.5;
  const dir = tot > 0 ? (upScore - dnScore) / tot : 0;
  return { perMin, upFrac, dir };
}

export function scoreToTone(
  x: number,
  upLabel: string,
  downLabel: string,
): { label: string; cls: string } {
  if (x > 0.22) return { label: `🟢 Strong ${upLabel} pressure`, cls: 'border-emerald-700/40 bg-emerald-950/25 text-emerald-200' };
  if (x > 0.08) return { label: `🟡 Mild ${upLabel} pressure`, cls: 'border-amber-700/35 bg-amber-950/20 text-amber-100' };
  if (x < -0.22) return { label: `🔴 Strong ${downLabel} pressure`, cls: 'border-rose-700/40 bg-rose-950/25 text-rose-200' };
  if (x < -0.08) return { label: `🟠 Mild ${downLabel} pressure`, cls: 'border-amber-700/35 bg-amber-950/20 text-amber-100' };
  return { label: 'Neutral / two-sided', cls: 'border-zinc-700/45 bg-zinc-900/35 text-zinc-300' };
}

export function supportShift(series: BookSnapshot[]): { label: string; dir: 'up' | 'down' | 'flat' } {
  const mids = series.filter((s) => s.mid != null).slice(-12);
  if (mids.length < 4) return { label: 'Support shift: —', dir: 'flat' };
  const a = mids[0]!.mid!;
  const b = mids[mids.length - 1]!.mid!;
  const d = b - a;
  if (Math.abs(d) < 0.002) return { label: 'Support shift: flat', dir: 'flat' };
  return d > 0 ? { label: 'Support shift: rising', dir: 'up' } : { label: 'Support shift: falling', dir: 'down' };
}

/** Book depth tilt + tape direction, same weighting as Flow Zones tab. */
export function flowPressureFromSnapsAndTape(
  lastUp: BookSnapshot | null,
  lastDn: BookSnapshot | null,
  tape: { perMin: number; dir: number },
): number {
  const imbU = lastUp?.imbalance;
  const imbD = lastDn?.imbalance;
  const imbDiff =
    imbU != null && imbD != null ? (imbU - imbD) / 2 : imbU != null ? imbU * 0.5 : imbD != null ? -imbD * 0.5 : 0;
  const speed = Math.min(1, tape.perMin / 50);
  const tapeDir = tape.dir;
  return imbDiff * 0.65 + tapeDir * speed * 0.35;
}
