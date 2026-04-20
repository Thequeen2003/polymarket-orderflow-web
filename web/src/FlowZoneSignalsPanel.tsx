import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { ClobBookEntry, DataTradeRow } from './lib/api';
import { recentTrades } from './lib/api';
import { pickConditionId } from './bookIntel';
import { displayPrice, midPrice, pickBookLevels, topOfBook } from './bookLevels';
import { depthCurve, depthCurveToPath, firstWall } from './flowZoneDepthUtils';
import { flowPressureFromSnapsAndTape, scoreToTone, supportShift, tapeDirectionalStats } from './flowZoneIntel';
import type { BookSnapshot } from './orderflowMetrics';
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
 * Flow zone strip + full depth chart (cumulative bids/asks) + liquidity walls + shift + decision box.
 * Single tape poll for Signals tab (matches Flow Zones “Flow intelligence” panels 2–5).
 */
export function FlowZoneSignalsPanel(props: {
  market: unknown | null;
  books: ClobBookEntry[] | null;
  outcomeLabels: string[];
  flowSeriesForSlug: Record<string, BookSnapshot[]> | null;
  priceToBeatUsd: number | null;
  endsInMs: number | null;
  booksFetchedAt: number | null;
}): ReactElement {
  const { market, books, outcomeLabels, flowSeriesForSlug, priceToBeatUsd, endsInMs, booksFetchedAt } = props;

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
  const [tapeRows, setTapeRows] = useState<DataTradeRow[]>([]);
  const [tapeErr, setTapeErr] = useState<string | null>(null);

  const loadTape = useCallback(async () => {
    if (!conditionId) return;
    setTapeErr(null);
    const res = await recentTrades({ market: conditionId, limit: 120 });
    if (isOk<DataTradeRow[]>(res)) setTapeRows(Array.isArray(res.data) ? res.data : []);
    else setTapeErr(JSON.stringify((res as { details?: unknown }).details ?? res));
  }, [conditionId]);

  useEffect(() => {
    const id = window.setInterval(() => void loadTape(), 8_000);
    void Promise.resolve().then(() => loadTape());
    return () => window.clearInterval(id);
  }, [loadTape]);

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

  const dom = useMemo(() => {
    const e = activeToken && up && down ? (activeToken === up.token ? up : down) : up ?? down ?? null;
    if (!e || e.error) return null;
    const side: 'up' | 'down' =
      activeToken && up && down ? (activeToken === up.token ? 'up' : 'down') : e === down ? 'down' : 'up';
    const outcomeLabel = side === 'up' ? upName : dnName;
    const { bids, asks } = pickBookLevels(e.book);
    const tob = topOfBook(e.book);
    const mid = midPrice(e.book);
    return {
      bids: bids.slice(0, 18),
      asks: asks.slice(0, 18),
      tob,
      mid,
      token: e.token,
      side,
      outcomeLabel,
    };
  }, [activeToken, dnName, down, up, upName]);

  const wall = useMemo(() => {
    if (!dom) return { ask: null as null | { price: number; size: number }, bid: null as null | { price: number; size: number } };
    return { ask: firstWall(dom.asks, 1200), bid: firstWall(dom.bids, 1200) };
  }, [dom]);

  const decision = useMemo(() => {
    const fastTape = tape.perMin >= 22;
    const upHeavy = tape.upFrac >= 0.58;
    const dnHeavy = tape.upFrac <= 0.42;
    const thinAsk = wall.ask == null;
    const thinBid = wall.bid == null;
    const churn = (lastUp?.churn ?? 0) + (lastDn?.churn ?? 0);
    const churny = churn >= 800;

    const parts: string[] = [];
    if (thinAsk && upHeavy && fastTape) parts.push(`thin above, ${upName} pressure real`);
    if (!thinAsk && wall.ask) parts.push(`ask wall near ${displayPrice(wall.ask.price)} — don’t chase into it`);
    if (thinBid && dnHeavy && fastTape) parts.push(`thin below, ${dnName} pressure real`);
    if (!thinBid && wall.bid) parts.push(`bid wall near ${displayPrice(wall.bid.price)} — bounce risk into it`);
    if (churny) parts.push('quotes moving fast (churn high) — treat walls as dynamic');
    if (shift.dir === 'up') parts.push('support stepping up');
    if (shift.dir === 'down') parts.push('support fading');
    if (parts.length === 0) parts.push('two-sided / unclear — wait for tape burst + wall reaction');
    return parts.join(' · ');
  }, [dnName, lastDn?.churn, lastUp?.churn, shift.dir, tape.perMin, tape.upFrac, upName, wall.ask, wall.bid]);

  const wCurve = useMemo(() => {
    if (!dom) return null;
    return { bids: depthCurve(dom.bids, 18), asks: depthCurve(dom.asks, 18) };
  }, [dom]);

  const endsIn = endsInMs != null ? endsInMs : null;

  return (
    <div className="space-y-4">
      {/* Header strip (same as FlowZoneStrip) */}
      <div className="rounded-2xl border border-zinc-800/60 bg-gradient-to-b from-zinc-950/90 to-zinc-950/50 p-4 ring-1 ring-white/[0.04]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[13px] font-semibold tracking-tight text-zinc-100">Flow zone</div>
            <p className="mt-0.5 text-[11px] text-zinc-500">Tape + book imbalance vs mid shift (same as Flow Zones)</p>
          </div>
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

      {/* Depth chart + same Flow intelligence stack as Flow Zones tab */}
      <div className="rounded-2xl border border-zinc-800/60 bg-gradient-to-b from-zinc-950/90 to-zinc-950/40 p-4 ring-1 ring-white/[0.04]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/50 pb-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Depth & liquidity</div>
            <p className="mt-0.5 text-[11px] text-zinc-500">Cumulative book shape on the higher-mid outcome</p>
          </div>
          <div className="font-mono text-[11px] text-zinc-500">
            {dom?.mid != null ? `mid ${displayPrice(dom.mid)}` : 'mid —'} ·{' '}
            {booksFetchedAt ? new Date(booksFetchedAt).toLocaleTimeString() : '—'}
          </div>
        </div>
        {dom ? (
          <p className="mt-1 text-[10px] leading-snug text-zinc-500">
            Cumulative depth on <span className="font-semibold text-zinc-300">{dom.outcomeLabel}</span> (higher-mid token). Up ={' '}
            <span className="text-emerald-300/90">{upName}</span> · Down = <span className="text-sky-300/90">{dnName}</span>
          </p>
        ) : (
          <p className="mt-1 text-[10px] text-zinc-600">Load a two-outcome book to plot depth.</p>
        )}

        {tapeErr ? <pre className="mt-2 overflow-auto rounded-lg bg-red-950/20 p-2 text-[11px] text-red-200/90">{tapeErr}</pre> : null}

        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-zinc-800/60 bg-black/20 p-4">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Liquidity map</div>
            <div className="mt-2 text-[11px] text-zinc-400">
              First wall:{' '}
              <span className="text-zinc-200">
                {wall.ask ? `ask ${displayPrice(wall.ask.price)} × ${wall.ask.size.toFixed(0)}` : 'ask —'}
              </span>{' '}
              ·{' '}
              <span className="text-zinc-200">
                {wall.bid ? `bid ${displayPrice(wall.bid.price)} × ${wall.bid.size.toFixed(0)}` : 'bid —'}
              </span>
            </div>
            <div className="mt-2 text-[11px] text-zinc-500">Thinness = no large wall in top levels (≥1200 sh).</div>
          </div>

          <div className="rounded-xl border border-zinc-800/60 bg-black/20 p-4">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Shift detector</div>
            <div
              className={`mt-2 text-[12px] font-semibold ${
                shift.dir === 'up' ? 'text-emerald-300' : shift.dir === 'down' ? 'text-rose-300' : 'text-zinc-300'
              }`}
            >
              {dom ? (
                <>
                  {dom.outcomeLabel} mid: {shift.dir === 'up' ? 'rising' : shift.dir === 'down' ? 'falling' : 'flat'}
                </>
              ) : (
                shift.label
              )}
            </div>
            {dom ? (
              <p className="mt-1 text-[10px] leading-snug text-zinc-500">Same snapshot series as Book tab flow.</p>
            ) : null}
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-zinc-800/50 bg-zinc-950/50 p-3 ring-1 ring-white/[0.02]">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Depth curve (cumulative)</div>
          <svg viewBox="0 0 320 160" className="mt-2 h-[180px] w-full max-w-xl rounded-lg">
            <rect x="0" y="0" width="320" height="160" rx="10" className="fill-[#050506] stroke-zinc-800/60" />
            {wCurve ? (
              <>
                <path
                  d={depthCurveToPath(wCurve.bids, 320, 160, 10)}
                  fill="none"
                  stroke="rgb(56 189 248)"
                  strokeWidth={2}
                  opacity={0.95}
                />
                <path
                  d={depthCurveToPath(wCurve.asks, 320, 160, 10)}
                  fill="none"
                  stroke="rgb(251 113 133)"
                  strokeWidth={2}
                  opacity={0.95}
                />
              </>
            ) : null}
            <text x="12" y="20" className="fill-zinc-500" fontSize="10" fontFamily="ui-monospace, monospace">
              {dom ? `${dom.outcomeLabel}: ` : ''}bids (blue) / asks (red) · cumulative size by level
            </text>
          </svg>
        </div>

        <div className="mt-3 rounded-xl border border-indigo-800/30 bg-indigo-950/20 p-4 text-[12px] leading-relaxed text-indigo-100/90">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-indigo-300/80">Decision box</div>
          <div className="mt-2 text-[13px] font-semibold text-zinc-50">{decision}</div>
          <div className="mt-2 text-[11px] text-zinc-400">Where is pressure? Is it real? Is there room? Where will it stall?</div>
        </div>
      </div>
    </div>
  );
}
