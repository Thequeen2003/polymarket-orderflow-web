import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { ClobBookEntry, DataTradeRow } from './lib/api';
import { recentTrades } from './lib/api';
import { pickConditionId } from './bookIntel';
import { displayPrice, midPrice, pickBookLevels, topOfBook } from './bookLevels';
import { flowPressureFromSnapsAndTape, scoreToTone, supportShift, tapeDirectionalStats } from './flowZoneIntel';
import type { BookSnapshot } from './orderflowMetrics';
import { depthCurve, depthCurveToPath, firstWall } from './flowZoneDepthUtils';
import { FlowZoneStrip } from './FlowZoneStrip';
import { resolveUpDownIndices } from './upDown';

function isOk<T>(x: unknown): x is { ok: true; data: T } {
  return typeof x === 'object' && x !== null && (x as { ok?: boolean }).ok === true && 'data' in (x as object);
}

export function FlowZonesTab(props: {
  market: unknown | null;
  books: ClobBookEntry[] | null;
  outcomeLabels: string[];
  flowSeriesForSlug: Record<string, BookSnapshot[]> | null;
  booksFetchedAt: number | null;
  priceToBeatUsd: number | null;
  endsInMs: number | null;
}): ReactElement {
  const { market, books, outcomeLabels, flowSeriesForSlug, booksFetchedAt, priceToBeatUsd, endsInMs } = props;
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
    // For pressure, we need *both* outcomes; do not filter by active token.
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

  const shift = useMemo(() => supportShift(activeToken && up && down ? (activeToken === up.token ? snapsUp : snapsDn) : snapsUp), [activeToken, down, snapsDn, snapsUp, up]);

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

  return (
    <div className="space-y-3">
      <FlowZoneStrip
        market={market}
        books={books}
        outcomeLabels={outcomeLabels}
        flowSeriesForSlug={flowSeriesForSlug}
        priceToBeatUsd={priceToBeatUsd}
        endsInMs={endsInMs}
        tapeRows={tapeRows}
        stripTitle="Flow Zones"
      />

      {/* Layout: DOM is the star (full width). Tape + intel sit below in two columns. */}
      <div className="grid grid-cols-1 gap-3">
        {/* 1) Center: decision zone + DOM (full width) */}
        <div className="min-w-0 rounded-2xl border border-zinc-800/60 bg-zinc-950/35 p-5 ring-1 ring-white/[0.02]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[12px] font-semibold uppercase tracking-wide text-zinc-400">Decision zone (DOM)</div>
              {dom ? (
                <div className="mt-1 text-[10px] leading-snug text-zinc-500">
                  Ladder = <span className="font-semibold text-zinc-200">{dom.outcomeLabel}</span> token (
                  <span className={dom.side === 'up' ? 'text-emerald-300/90' : 'text-sky-300/90'}>
                    {dom.side === 'up' ? 'up' : 'down'} lane
                  </span>
                  ). We pick whichever side has the <span className="text-zinc-300">higher mid</span> so the book is the “hot”
                  contract.
                </div>
              ) : null}
            </div>
            <div className="font-mono text-[11px] text-zinc-500">
              {dom?.mid != null ? `mid ${displayPrice(dom.mid)}` : 'mid —'} · {booksFetchedAt ? new Date(booksFetchedAt).toLocaleTimeString() : '—'}
            </div>
          </div>

          {dom ? (
            <div className="mt-3 overflow-hidden rounded-2xl border border-zinc-800/60 bg-black/25">
              <div className="border-b border-zinc-800/60 bg-zinc-900/40 px-3 py-2 text-center text-[10px] leading-snug text-zinc-400">
                Prices are <span className="font-semibold text-zinc-200">{dom.outcomeLabel}</span> implied probability · Bids
                (left) vs asks (right) on <span className="font-mono text-zinc-300">that</span> outcome only · Up lane ={' '}
                <span className="text-emerald-300/90">{upName}</span> · Down lane = <span className="text-sky-300/90">{dnName}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 border-b border-zinc-800/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                <span className="text-sky-300/90">Bids · {dom.outcomeLabel}</span>
                <span className="text-center text-zinc-500">Price</span>
                <span className="text-right text-rose-300/90">Asks · {dom.outcomeLabel}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 px-3 py-2 font-mono text-[12px]">
                <div className="text-sky-200/90">{dom.tob.bestBid != null ? displayPrice(dom.tob.bestBid) : '—'}</div>
                <div className="text-center text-zinc-400">touch</div>
                <div className="text-right text-rose-200/90">{dom.tob.bestAsk != null ? displayPrice(dom.tob.bestAsk) : '—'}</div>
              </div>
              <div className="grid grid-cols-[1fr_96px_1fr] gap-2 border-t border-zinc-800/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                <span>Size</span>
                <span className="text-center">Px</span>
                <span className="text-right">Size</span>
              </div>
              <div className="max-h-[min(76vh,46rem)] overflow-auto">
                {Array.from({ length: Math.max(dom.bids.length, dom.asks.length) }, (_, i) => {
                  const b = dom.bids[i] ?? null;
                  const a = dom.asks[i] ?? null;
                  const px = b?.price ?? a?.price ?? null;
                  return (
                    <div
                      key={i}
                      className={`grid grid-cols-[1fr_96px_1fr] gap-2 px-4 py-2.5 text-[13px] ${
                        i % 2 === 0 ? 'bg-transparent' : 'bg-zinc-900/15'
                      }`}
                    >
                      <div className="text-sky-200/90 tabular-nums">{b ? b.size.toFixed(0) : ''}</div>
                      <div className="text-center text-zinc-100 tabular-nums">{px != null ? displayPrice(px) : ''}</div>
                      <div className="text-right text-rose-200/90 tabular-nums">{a ? a.size.toFixed(0) : ''}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="mt-3 rounded-xl border border-zinc-800/60 bg-black/20 p-4 text-sm text-zinc-500">
              Load a two-outcome book to see the DOM.
            </div>
          )}
        </div>

        {/* 2) Bottom row: tape + intelligence */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,34%)_minmax(0,66%)]">
          {/* Left: tape (narrow, scrollable) */}
          <div className="min-w-0 rounded-2xl border border-zinc-800/60 bg-zinc-950/35 p-4 ring-1 ring-white/[0.02]">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-zinc-400">Tape / real activity</div>
            <div className="mt-2 rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2 text-[11px] text-zinc-400">
              <div>
                Speed:{' '}
                <span className={tape.perMin >= 22 ? 'text-emerald-300' : tape.perMin >= 10 ? 'text-amber-200' : 'text-zinc-500'}>
                  {tape.perMin >= 22 ? 'FAST (real)' : tape.perMin >= 10 ? 'MED' : 'SLOW (could be fake)'}
                </span>
              </div>
            <div className="mt-1">
              Directional tape: {upName} {(tape.upFrac * 100).toFixed(0)}% / {dnName} {(100 - tape.upFrac * 100).toFixed(0)}%
            </div>
            </div>
            {tapeErr ? <pre className="mt-2 overflow-auto rounded-lg bg-red-950/20 p-2 text-[11px] text-red-200/90">{tapeErr}</pre> : null}
            <div className="mt-3 max-h-[min(58vh,30rem)] overflow-auto rounded-xl border border-zinc-800/60 bg-black/25">
              {tapeRows.length === 0 ? (
                <div className="p-3 text-xs text-zinc-600">No prints yet (or Data API lagging).</div>
              ) : (
                <table className="w-full border-collapse text-left text-[11px] text-zinc-300">
                  <thead className="sticky top-0 bg-zinc-900/95 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                    <tr>
                      <th className="border-b border-zinc-800/60 px-2 py-2">Side</th>
                      <th className="border-b border-zinc-800/60 px-2 py-2">Px</th>
                      <th className="border-b border-zinc-800/60 px-2 py-2">Sz</th>
                      <th className="border-b border-zinc-800/60 px-2 py-2">t</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tapeRows.slice(0, 60).map((t, i) => (
                      <tr
                        key={`${t.transactionHash ?? i}-${t.timestamp}`}
                        className={`border-b border-zinc-800/25 ${
                          (t.size ?? 0) >= 250 ? 'bg-amber-950/20' : (t.size ?? 0) >= 80 ? 'bg-zinc-900/20' : ''
                        }`}
                      >
                        <td
                          className={`px-2 py-1.5 ${
                            t.side === 'BUY' ? 'text-emerald-300/90' : t.side === 'SELL' ? 'text-rose-300/90' : 'text-zinc-500'
                          }`}
                        >
                          {t.side || '—'}
                        </td>
                        <td className="px-2 py-1.5 font-mono">{t.price != null ? t.price.toFixed(4) : '—'}</td>
                        <td className="px-2 py-1.5 font-mono text-zinc-400">{t.size != null ? t.size.toFixed(1) : '—'}</td>
                        <td className="px-2 py-1.5 font-mono text-[10px] text-zinc-600">
                          {t.timestamp ? new Date(t.timestamp * 1000).toLocaleTimeString() : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Right: stacked flow panels (full width of right column) */}
          <div className="min-w-0 rounded-2xl border border-zinc-800/60 bg-zinc-950/35 p-4 ring-1 ring-white/[0.02]">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-zinc-400">Flow intelligence</div>
            <div className="mt-3 space-y-3">
            <div className="rounded-xl border border-zinc-800/60 bg-black/20 p-4">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">1) Flow pressure</div>
              <div className="mt-2 text-[12px] font-semibold text-zinc-200">{tone.label}</div>
              <div className="mt-1 text-[11px] text-zinc-400">
                Is it real:{' '}
                <span className={tape.perMin >= 22 && Math.abs(pressure) > 0.12 ? 'text-emerald-300' : 'text-zinc-500'}>
                  {tape.perMin >= 22 && Math.abs(pressure) > 0.12 ? 'Likely (tape fast + pressure)' : 'Unclear (need tape burst + follow-through)'}
                </span>
              </div>
            </div>

            <div className="rounded-xl border border-zinc-800/60 bg-black/20 p-4">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">2) Liquidity map</div>
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
              <div className="mt-2 text-[11px] text-zinc-500">Thinness is inferred by missing large walls in top levels.</div>
            </div>

            <div className="rounded-xl border border-zinc-800/60 bg-black/20 p-4">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">3) Depth curve</div>
              <svg viewBox="0 0 320 160" className="mt-2 h-[160px] w-full">
                <rect x="0" y="0" width="320" height="160" rx="10" className="fill-zinc-950 stroke-zinc-800/50" />
                {wCurve ? (
                  <>
                    <path d={depthCurveToPath(wCurve.bids, 320, 160, 10)} fill="none" stroke="rgb(56 189 248)" strokeWidth={2} opacity={0.95} />
                    <path d={depthCurveToPath(wCurve.asks, 320, 160, 10)} fill="none" stroke="rgb(251 113 133)" strokeWidth={2} opacity={0.95} />
                  </>
                ) : null}
                <text x="12" y="20" className="fill-zinc-500" fontSize="10" fontFamily="ui-monospace, monospace">
                  {dom ? `${dom.outcomeLabel}: ` : ''}bids (blue) / asks (red)
                </text>
              </svg>
            </div>

            <div className="rounded-xl border border-zinc-800/60 bg-black/20 p-4">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">4) Shift detector</div>
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
                <p className="mt-1 text-[10px] leading-snug text-zinc-500">Same series as the DOM ({dom.outcomeLabel} snapshots).</p>
              ) : null}
            </div>

            <div className="rounded-xl border border-indigo-800/30 bg-indigo-950/20 p-4 text-[12px] leading-relaxed text-indigo-100/90">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-indigo-300/80">5) Decision box</div>
              <div className="mt-2 text-[13px] font-semibold text-zinc-50">{decision}</div>
              <div className="mt-2 text-[11px] text-zinc-400">Where is pressure? Is it real? Is there room? Where will it stall?</div>
            </div>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

