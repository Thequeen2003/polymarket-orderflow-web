import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { ClobBookEntry, DataTradeRow } from './lib/api';
import { recentTrades } from './lib/api';
import { pickConditionId } from './bookIntel';
import { midPrice } from './bookLevels';
import type { BookSnapshot } from './orderflowMetrics';
import { flowPressureFromSnapsAndTape, scoreToTone, supportShift, tapeDirectionalStats } from './flowZoneIntel';
import { resolveUpDownIndices } from './upDown';

function isOk<T>(x: unknown): x is { ok: true; data: T } {
  return typeof x === 'object' && x !== null && (x as { ok?: boolean }).ok === true && 'data' in (x as object);
}

function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

/**
 * Compact Flow Zones strip (tape + book imbalance tone + mid shift) — same intel as the Flow Zones tab header.
 * Pass `tapeRows` from a parent that already polls trades (e.g. Flow Zones tab) to avoid duplicate API calls.
 */
export function FlowZoneStrip(props: {
  market: unknown | null;
  books: ClobBookEntry[] | null;
  outcomeLabels: string[];
  flowSeriesForSlug: Record<string, BookSnapshot[]> | null;
  priceToBeatUsd: number | null;
  endsInMs: number | null;
  /** When set, uses these rows instead of fetching (parent owns polling). */
  tapeRows?: DataTradeRow[];
  stripTitle?: string;
}): ReactElement {
  const {
    market,
    books,
    outcomeLabels,
    flowSeriesForSlug,
    priceToBeatUsd,
    endsInMs,
    tapeRows: tapeRowsProp,
    stripTitle = 'Flow zone',
  } = props;
  const [, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const idx = useMemo(() => resolveUpDownIndices(outcomeLabels, market), [outcomeLabels, market]);
  const up = idx && books ? books[idx.up] : null;
  const down = idx && books ? books[idx.down] : null;

  const activeToken = useMemo(() => {
    if (!up || !down || up.error || down.error) return null;
    const mu = midPrice(up.book);
    const md = midPrice(down.book);
    if (mu == null || md == null) return null;
    return mu >= md ? up.token : down.token;
  }, [down, up]);

  const conditionId = useMemo(() => pickConditionId(market), [market]);
  const [tapeRowsSelf, setTapeRowsSelf] = useState<DataTradeRow[]>([]);

  const loadTape = useCallback(async () => {
    if (!conditionId) return;
    const res = await recentTrades({ market: conditionId, limit: 120 });
    if (isOk<DataTradeRow[]>(res)) setTapeRowsSelf(Array.isArray(res.data) ? res.data : []);
  }, [conditionId]);

  useEffect(() => {
    if (tapeRowsProp !== undefined) return;
    const id = window.setInterval(() => void loadTape(), 8_000);
    void Promise.resolve().then(() => loadTape());
    return () => window.clearInterval(id);
  }, [loadTape, tapeRowsProp]);

  const tapeRows = tapeRowsProp !== undefined ? tapeRowsProp : tapeRowsSelf;

  const upTok = up?.token ?? null;
  const dnTok = down?.token ?? null;
  const upName = idx ? (outcomeLabels[idx.up] ?? 'Up') : 'Up';
  const dnName = idx ? (outcomeLabels[idx.down] ?? 'Down') : 'Down';
  const tape = useMemo(() => tapeDirectionalStats(tapeRows, upTok, dnTok), [dnTok, tapeRows, upTok]);

  const snapsUp = useMemo(() => (up ? flowSeriesForSlug?.[up.token] ?? [] : []), [flowSeriesForSlug, up]);
  const snapsDn = useMemo(() => (down ? flowSeriesForSlug?.[down.token] ?? [] : []), [flowSeriesForSlug, down]);
  const lastUp = snapsUp.length ? snapsUp[snapsUp.length - 1] : null;
  const lastDn = snapsDn.length ? snapsDn[snapsDn.length - 1] : null;

  const pressure = useMemo(() => flowPressureFromSnapsAndTape(lastUp, lastDn, tape), [lastDn, lastUp, tape]);

  const tone = scoreToTone(pressure, upName, dnName);

  const shift = useMemo(
    () => supportShift(activeToken && up && down ? (activeToken === up.token ? snapsUp : snapsDn) : snapsUp),
    [activeToken, down, snapsDn, snapsUp, up],
  );

  const endsIn = endsInMs != null ? endsInMs : null;

  return (
    <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/35 p-4 ring-1 ring-white/[0.02]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[13px] font-semibold tracking-tight text-zinc-100">{stripTitle}</div>
        <div className="font-mono text-[11px] text-zinc-500">
          {endsIn != null ? (endsIn >= 0 ? `ends in ${fmtAgo(endsIn)}` : `ended ${fmtAgo(-endsIn)} ago`) : '—'}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="rounded-xl border border-amber-700/40 bg-amber-950/20 px-3 py-2 font-mono text-[11px] text-amber-100/90">
          PTB {priceToBeatUsd != null ? `$${priceToBeatUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
        </div>
        <div className={`rounded-xl border px-3 py-2 text-[11px] font-semibold ${tone.cls}`}>{tone.label}</div>
        <div className="rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2 font-mono text-[11px] text-zinc-400">
          Tape {tape.perMin.toFixed(0)}/min · {upName} {(tape.upFrac * 100).toFixed(0)}% / {dnName}{' '}
          {(100 - tape.upFrac * 100).toFixed(0)}%
        </div>
        <div
          className="rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2 font-mono text-[11px] text-zinc-400"
          title="Uses the same outcome as the higher mid between the two books."
        >
          Mid ({activeToken && up && down ? (activeToken === up.token ? upName : dnName) : '—'}):{' '}
          <span
            className={
              shift.dir === 'up' ? 'text-emerald-300/90' : shift.dir === 'down' ? 'text-rose-300/90' : 'text-zinc-500'
            }
          >
            {shift.dir === 'up' ? 'rising' : shift.dir === 'down' ? 'falling' : 'flat'}
          </span>
        </div>
      </div>
    </div>
  );
}
