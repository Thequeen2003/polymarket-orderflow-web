import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  clearTradeHistory,
  loadTradeHistory,
  tradeHistoryToCsv,
  TRADE_HISTORY_CHANGED_EVENT,
  type TradeHistoryRow,
} from './tradeHistory';

function fmtUsdCents(v: number | null): string {
  if (v == null) return '—';
  const dollars = v / 100;
  const sign = dollars < 0 ? '-' : '';
  return `${sign}$${Math.abs(dollars).toFixed(2)}`;
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '—';
  }
}

function downloadTextFile(filename: string, content: string, mime = 'text/plain;charset=utf-8') {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    /* ignore */
  }
}

/** Full-width trade log from browser localStorage (paper + live rows). */
export function TradeHistoryTab(): ReactElement {
  const [historyRows, setHistoryRows] = useState<TradeHistoryRow[]>(() => loadTradeHistory());
  const [historyQuery, setHistoryQuery] = useState('');
  const [historySide, setHistorySide] = useState<'all' | 'buy' | 'sell'>('all');
  const [historyMode, setHistoryMode] = useState<'all' | 'paper' | 'live'>('all');
  const [historyStatus, setHistoryStatus] = useState<
    'all' | 'filled' | 'sent' | 'sending' | 'failed' | 'no_fill' | 'submitted'
  >('all');

  const reload = useCallback(() => setHistoryRows(loadTradeHistory()), []);

  useEffect(() => {
    reload();
    let t: ReturnType<typeof window.setTimeout> | null = null;
    const onEvt = () => {
      if (t != null) window.clearTimeout(t);
      t = window.setTimeout(() => {
        t = null;
        reload();
      }, 150);
    };
    window.addEventListener(TRADE_HISTORY_CHANGED_EVENT, onEvt);
    return () => {
      if (t != null) window.clearTimeout(t);
      window.removeEventListener(TRADE_HISTORY_CHANGED_EVENT, onEvt);
    };
  }, [reload]);

  const filteredHistory = useMemo(() => {
    const q = historyQuery.trim().toLowerCase();
    const out: TradeHistoryRow[] = [];
    for (let i = 0; i < historyRows.length; i++) {
      const r = historyRows[i]!;
      if (historySide !== 'all' && r.side !== historySide) continue;
      if (historyMode !== 'all' && r.mode !== historyMode) continue;
      if (historyStatus !== 'all') {
        const st = r.status;
        if (historyStatus === 'submitted' && st !== 'submitted' && st !== 'sent') continue;
        else if (historyStatus !== 'submitted' && st !== historyStatus) continue;
      }
      if (q) {
        const hay = `${r.label} ${r.token} ${r.exec} ${r.mode} ${r.side} ${r.status} ${r.marketSlug ?? ''} ${r.marketTitle ?? ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push(r);
    }
    return out;
  }, [historyMode, historyQuery, historyRows, historySide, historyStatus]);

  const historySummary = useMemo(() => {
    let buys = 0;
    let sells = 0;
    let submitted = 0;
    let errors = 0;
    let netUsdCents = 0;
    for (const r of filteredHistory) {
      if (r.side === 'buy') buys++;
      else sells++;
      if (r.status === 'submitted' || r.status === 'sent') submitted++;
      else if (r.status === 'error' || r.status === 'failed') errors++;
      if (r.usdCents != null) {
        const abs = Math.abs(r.usdCents);
        netUsdCents += r.side === 'buy' ? -abs : abs;
      }
    }
    return { buys, sells, submitted, errors, netUsdCents };
  }, [filteredHistory]);

  return (
    <div className="mt-5 space-y-4">
      <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/40 p-4 ring-1 ring-white/[0.02]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Trade history</h2>
            <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-zinc-500">
              Log of orders from this browser (Practice + Live). Updates live when you trade or clear from anywhere in the app.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                const csv = tradeHistoryToCsv(historyRows);
                downloadTextFile(`polymarket-trade-history-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8');
              }}
              className="rounded-lg border border-zinc-700/60 bg-zinc-900/50 px-3 py-2 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-800/70"
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={() => {
                clearTradeHistory();
                setHistoryRows([]);
              }}
              className="rounded-lg border border-rose-800/40 bg-rose-950/20 px-3 py-2 text-[11px] font-semibold text-rose-100 hover:bg-rose-950/35"
            >
              Clear all
            </button>
          </div>
        </div>
      </div>

      {historyRows.length ? (
        <div className="overflow-hidden rounded-2xl border border-zinc-800/60 bg-black/20 ring-1 ring-white/[0.02]">
          <div className="border-b border-zinc-800/60 bg-zinc-950/90 p-3 backdrop-blur">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <input
                  value={historyQuery}
                  onChange={(e) => setHistoryQuery(e.target.value)}
                  placeholder="Search label, token, slug, market…"
                  className="h-10 min-w-0 flex-1 rounded-lg border border-zinc-800/70 bg-black/30 px-3 text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-600/80 sm:min-w-[240px] sm:max-w-md"
                />
                <select
                  value={historySide}
                  onChange={(e) => setHistorySide(e.target.value as 'all' | 'buy' | 'sell')}
                  className="h-10 rounded-lg border border-zinc-800/70 bg-black/30 px-2.5 text-[12px] text-zinc-200 outline-none"
                  aria-label="Filter by side"
                >
                  <option value="all">All sides</option>
                  <option value="buy">Buys</option>
                  <option value="sell">Sells</option>
                </select>
                <select
                  value={historyMode}
                  onChange={(e) => setHistoryMode(e.target.value as 'all' | 'paper' | 'live')}
                  className="h-10 rounded-lg border border-zinc-800/70 bg-black/30 px-2.5 text-[12px] text-zinc-200 outline-none"
                  aria-label="Filter by mode"
                >
                  <option value="all">All modes</option>
                  <option value="paper">Paper</option>
                  <option value="live">Live</option>
                </select>
                <select
                  value={historyStatus}
                  onChange={(e) =>
                    setHistoryStatus(
                      e.target.value as 'all' | 'filled' | 'sent' | 'sending' | 'failed' | 'no_fill' | 'submitted',
                    )
                  }
                  className="h-10 rounded-lg border border-zinc-800/70 bg-black/30 px-2.5 text-[12px] text-zinc-200 outline-none"
                  aria-label="Filter by status"
                >
                  <option value="all">All status</option>
                  <option value="filled">Filled</option>
                  <option value="sent">Sent / resting</option>
                  <option value="sending">Sending</option>
                  <option value="no_fill">No fill</option>
                  <option value="failed">Failed</option>
                  <option value="submitted">Submitted (legacy)</option>
                </select>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
                <span className="font-mono text-zinc-500">
                  Showing {filteredHistory.length}/{historyRows.length}
                </span>
                <span className="rounded-full border border-zinc-800/70 bg-black/25 px-2.5 py-1 font-mono tabular-nums text-zinc-300">
                  Net {fmtUsdCents(historySummary.netUsdCents)}
                </span>
                {historySummary.submitted ? (
                  <span className="rounded-full border border-zinc-800/70 bg-black/25 px-2.5 py-1 font-mono text-zinc-300">
                    Submitted {historySummary.submitted}
                  </span>
                ) : null}
                {historySummary.errors ? (
                  <span className="rounded-full border border-rose-800/40 bg-rose-950/20 px-2.5 py-1 font-mono text-rose-200/90">
                    Errors {historySummary.errors}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <div className="max-h-[min(70vh,720px)] overflow-auto">
            <table className="w-full min-w-[1040px] border-collapse text-left text-[12px]">
              <thead className="sticky top-0 z-[1] bg-zinc-950/95 backdrop-blur">
                <tr className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                  <th className="whitespace-nowrap px-3 py-2.5">Time</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Mode</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Side</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Exec</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Outcome</th>
                  <th className="min-w-[7rem] px-3 py-2.5">Market</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Quoted</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Sent</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Fill</th>
                  <th className="whitespace-nowrap px-3 py-2.5">RTT</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right">Shares</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right">USD</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="align-top">
                {filteredHistory.slice(0, 250).map((r) => (
                  <tr key={r.id} className="border-t border-zinc-900/70 hover:bg-zinc-900/20">
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-zinc-500">{fmtTime(r.ts)}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                          r.mode === 'paper' ? 'border-amber-500/25 bg-amber-950/20 text-amber-100/90' : 'border-sky-500/25 bg-sky-950/15 text-sky-100/90'
                        }`}
                      >
                        {r.mode}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`font-bold ${r.side === 'buy' ? 'text-emerald-200' : 'text-rose-200'}`}>{r.side}</span>
                    </td>
                    <td className="px-3 py-2 text-zinc-400">{r.exec}</td>
                    <td className="max-w-[10rem] px-3 py-2">
                      <span className="line-clamp-2 rounded-lg border border-zinc-800/70 bg-black/20 px-2 py-1 text-[11px] font-semibold text-zinc-200/95">
                        {r.label || '—'}
                      </span>
                    </td>
                    <td className="max-w-[12rem] px-3 py-2">
                      <div className="truncate font-mono text-[10px] text-zinc-500" title={r.marketSlug || r.marketTitle || ''}>
                        {r.marketSlug || '—'}
                      </div>
                      {r.marketTitle ? (
                        <div className="mt-0.5 line-clamp-1 text-[10px] text-zinc-600" title={r.marketTitle}>
                          {r.marketTitle}
                        </div>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono tabular-nums text-zinc-400">
                      {r.quotedPrice01 == null ? '—' : `${(r.quotedPrice01 * 100).toFixed(1)}¢`}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono tabular-nums text-zinc-400">
                      {r.submittedPrice01 == null ? '—' : `${(r.submittedPrice01 * 100).toFixed(1)}¢`}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono tabular-nums text-zinc-200">
                      {r.fillAvgPrice01 == null ? '—' : `${(r.fillAvgPrice01 * 100).toFixed(2)}¢`}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-zinc-500">
                      {r.roundTripMs == null ? '—' : `${r.roundTripMs}ms`}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums text-zinc-300">
                      {r.shares == null ? '—' : r.shares.toFixed(2)}
                    </td>
                    <td
                      className={`whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums ${
                        r.side === 'buy' ? 'text-zinc-200' : 'text-emerald-200/90'
                      }`}
                    >
                      {r.usdCents == null ? '—' : fmtUsdCents(r.side === 'buy' ? -Math.abs(r.usdCents) : Math.abs(r.usdCents))}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                          r.status === 'filled'
                            ? 'border-emerald-700/35 bg-emerald-950/15 text-emerald-200/90'
                            : r.status === 'sent' || r.status === 'submitted'
                              ? 'border-sky-700/35 bg-sky-950/15 text-sky-200/85'
                              : r.status === 'sending'
                                ? 'border-amber-700/35 bg-amber-950/15 text-amber-200/90'
                                : r.status === 'no_fill' || r.status === 'cancelled'
                                  ? 'border-zinc-600/40 bg-zinc-950/25 text-zinc-300/90'
                                  : r.status === 'partial'
                                    ? 'border-violet-700/35 bg-violet-950/15 text-violet-200/90'
                                    : 'border-rose-700/35 bg-rose-950/15 text-rose-200/90'
                        }`}
                        title={r.auditNote ? `${r.auditNote}${r.error ? ` · ${r.error}` : ''}` : r.error || r.auditNote || ''}
                      >
                        {r.status === 'submitted' ? 'sent' : r.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-800/60 bg-black/15 px-4 py-10 text-center text-[13px] text-zinc-500">No trades yet.</div>
      )}
    </div>
  );
}
