/**
 * Polls Polymarket's Data API for the most recent prints on a given outcome
 * token and exposes them as `TapePrint[]` so the chart's tape-velocity sensor
 * can light up. Used by `SignalsPtbOnly` + `DualPtbReferenceTab`.
 *
 * Behavior:
 *   - Skips fetching when `conditionId` or `activeTokenId` is missing.
 *   - Polls every `intervalMs` (default 8s — same cadence used elsewhere for prints).
 *   - Cancels in-flight responses on input change to avoid race conditions.
 *   - Returns the latest array on success; preserves the previous list on transient errors
 *     so the strip doesn't blank out on a single failed poll.
 */
import { useEffect, useState } from 'react';
import { recentTrades, type ApiOk, type DataTradeRow } from './lib/api';
import type { TapePrint } from './tapeVelocity';

const DEFAULT_LIMIT = 60;
const DEFAULT_INTERVAL_MS = 8_000;

function isOk<T>(x: unknown): x is ApiOk<T> {
  return typeof x === 'object' && x !== null && (x as { ok?: boolean }).ok === true && 'data' in (x as object);
}

function rowToPrint(r: DataTradeRow): TapePrint | null {
  const ts = Number(r.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  if (r.size == null || !Number.isFinite(r.size) || r.size <= 0) return null;
  // Data API timestamps are seconds — convert to ms for the tape sensor.
  return {
    ts: ts * 1000,
    side: r.side === 'sell' ? 'sell' : 'buy',
    size: r.size,
  };
}

export function useRecentTapePrints(input: {
  conditionId: string | null | undefined;
  activeTokenId: string | null | undefined;
  intervalMs?: number;
  limit?: number;
}): TapePrint[] {
  const { conditionId, activeTokenId } = input;
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const [prints, setPrints] = useState<TapePrint[]>([]);

  useEffect(() => {
    if (!conditionId || !activeTokenId) {
      setPrints([]);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const res = await recentTrades({ market: conditionId, asset: activeTokenId, limit });
        if (!alive || !isOk<DataTradeRow[]>(res)) return;
        const next: TapePrint[] = [];
        for (const r of res.data ?? []) {
          const p = rowToPrint(r);
          if (p) next.push(p);
        }
        setPrints(next);
      } catch {
        /* keep prior prints on transient errors */
      }
    };
    void load();
    const id = window.setInterval(load, intervalMs);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [conditionId, activeTokenId, intervalMs, limit]);

  return prints;
}
