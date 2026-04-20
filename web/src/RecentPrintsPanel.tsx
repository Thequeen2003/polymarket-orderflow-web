import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { lastTradePrice, recentTrades, type ApiErr, type ApiOk, type DataTradeRow } from './lib/api';

function isOk<T>(x: unknown): x is ApiOk<T> {
  return typeof x === 'object' && x !== null && (x as { ok?: boolean }).ok === true && 'data' in (x as object);
}

function fmtTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function shortHash(h: string | null): string {
  if (!h || h.length < 12) return '—';
  return `${h.slice(0, 8)}…${h.slice(-6)}`;
}

export function ChurnVsTapeLegend(): ReactElement {
  return (
    <div className="rounded-2xl border border-zinc-800/50 bg-zinc-900/25 px-4 py-3 text-xs leading-relaxed text-zinc-400 ring-1 ring-white/[0.02]">
      <span className="font-semibold text-zinc-200">Churn vs tape:</span>{' '}
      <span className="text-zinc-300">Churn</span> (order-flow chart) measures how fast <span className="italic">quoted sizes</span> change on
      the book between polls — it can be pulls, adds, or cancels, not necessarily someone trading.{' '}
      <span className="text-zinc-300">Tape</span> (recent prints below) is matched trades from Polymarket’s Data API — real buys/sells at a price.
      Use churn for <span className="italic">liquidity behavior</span>; use tape for <span className="italic">who actually traded</span>.
    </div>
  );
}

export function RecentPrintsPanel(props: {
  conditionId: string | null;
  activeTokenId: string | null;
  outcomeLabel: string | null;
}): ReactElement {
  const { conditionId, activeTokenId, outcomeLabel } = props;
  const [rows, setRows] = useState<DataTradeRow[]>([]);
  const [lastPx, setLastPx] = useState<{ price: string; side: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [onlyOutcome, setOnlyOutcome] = useState(true);

  const load = useCallback(async () => {
    if (!conditionId) {
      setRows([]);
      setLastPx(null);
      setErr(null);
      return;
    }
    setErr(null);
    const res = await recentTrades({
      market: conditionId,
      limit: 60,
      asset: onlyOutcome && activeTokenId ? activeTokenId : undefined,
    });
    if (isOk<DataTradeRow[]>(res)) setRows(Array.isArray(res.data) ? res.data : []);
    else setErr(JSON.stringify((res as ApiErr).details ?? res));

    if (activeTokenId) {
      const lt = await lastTradePrice(activeTokenId);
      if (isOk(lt)) setLastPx(lt.data);
      else setLastPx(null);
    } else {
      setLastPx(null);
    }
  }, [conditionId, activeTokenId, onlyOutcome]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 12_000);
    return () => window.clearInterval(id);
  }, [load]);

  if (!conditionId) {
    return (
      <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/35 p-4 text-sm text-zinc-500 ring-1 ring-white/[0.02]">
        Load a market to see <span className="text-zinc-300">recent prints</span> (needs a Gamma <span className="font-mono">conditionId</span>).
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/35 p-4 shadow-inner shadow-black/15 ring-1 ring-white/[0.02]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[13px] font-semibold tracking-tight text-zinc-100">Recent prints (tape)</div>
          <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-zinc-500">
            Public <span className="font-mono text-zinc-400">data-api.polymarket.com</span> — no CLOB API keys. Updates on a timer; not sub-second
            WebSocket latency.
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-400">
          <input type="checkbox" checked={onlyOutcome} onChange={(e) => setOnlyOutcome(e.target.checked)} />
          Only {outcomeLabel ?? 'active'} token
        </label>
      </div>

      {activeTokenId && lastPx ? (
        <div className="mt-3 rounded-xl border border-indigo-900/35 bg-indigo-950/20 px-3 py-2 text-[11px] text-indigo-100/90">
          <span className="font-semibold text-indigo-200/90">CLOB last trade</span> ({outcomeLabel ?? 'active'}):{' '}
          <span className="font-mono">{lastPx.side || '—'}</span> @ <span className="font-mono">{lastPx.price || '—'}</span>
        </div>
      ) : null}

      {err ? (
        <pre className="mt-3 overflow-auto rounded-lg border border-red-900/40 bg-red-950/20 p-2 text-[11px] text-red-200/90">{err}</pre>
      ) : null}

      <div className="mt-3 max-h-56 overflow-auto rounded-xl border border-zinc-800/50 bg-black/25">
        {rows.length === 0 ? (
          <div className="p-3 text-xs text-zinc-600">No rows yet (or filter removed everything).</div>
        ) : (
          <table className="w-full border-collapse text-left text-[11px] text-zinc-300">
            <thead className="sticky top-0 z-[1] bg-zinc-900/95 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="border-b border-zinc-800/60 px-2 py-2">Time</th>
                <th className="border-b border-zinc-800/60 px-2 py-2">Side</th>
                <th className="border-b border-zinc-800/60 px-2 py-2">Price</th>
                <th className="border-b border-zinc-800/60 px-2 py-2">Size</th>
                <th className="border-b border-zinc-800/60 px-2 py-2">Out</th>
                <th className="border-b border-zinc-800/60 px-2 py-2">Trader</th>
                <th className="border-b border-zinc-800/60 px-2 py-2">Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t, i) => (
                <tr key={`${t.transactionHash ?? i}-${t.timestamp}`} className="border-b border-zinc-800/30 hover:bg-zinc-800/25">
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono text-zinc-500">{fmtTime(t.timestamp)}</td>
                  <td className="px-2 py-1.5">
                    <span
                      className={
                        t.side === 'BUY' ? 'text-emerald-300/90' : t.side === 'SELL' ? 'text-rose-300/90' : 'text-zinc-500'
                      }
                    >
                      {t.side || '—'}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 font-mono">{t.price != null ? t.price.toFixed(4) : '—'}</td>
                  <td className="px-2 py-1.5 font-mono">{t.size != null ? t.size.toFixed(2) : '—'}</td>
                  <td className="px-2 py-1.5 text-zinc-400">{t.outcome ?? '—'}</td>
                  <td className="max-w-[8rem] truncate px-2 py-1.5 text-zinc-500" title={t.pseudonym ?? ''}>
                    {t.pseudonym ?? '—'}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[10px] text-zinc-600">{shortHash(t.transactionHash)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
