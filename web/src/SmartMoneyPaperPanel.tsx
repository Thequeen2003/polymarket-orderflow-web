import { useState, type ReactElement } from 'react';
import { useSmartMoneyPaperBot } from './useSmartMoneyPaperBot';

function fmtCents(p: number | null): string {
  if (p == null || !Number.isFinite(p)) return '—';
  return `${(p * 100).toFixed(1)}¢`;
}

function fmtN(x: number): string {
  if (!Number.isFinite(x)) return '—';
  if (Math.abs(x) >= 100) return x.toFixed(0);
  if (Math.abs(x) >= 1) return x.toFixed(2);
  return x.toFixed(4);
}

export function SmartMoneyPaperPanel(): ReactElement {
  const { enabled, setEnabled, rows, eventTail, lastTickAt, globalErr } = useSmartMoneyPaperBot();
  const [open, setOpen] = useState(true);
  const [showOrders, setShowOrders] = useState(false);

  return (
    <div className="rounded-2xl border border-zinc-800/70 bg-[#0a0e14] px-3 py-2.5 ring-1 ring-white/[0.03]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-500/90">Paper smart-money</span>
          <span className="truncate text-xs text-zinc-400">BTC/ETH/SOL · 5m+15m · tape + buy-below / sell-up</span>
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-300">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 rounded border-zinc-600"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>Enable</span>
          </label>
          {lastTickAt ? (
            <span className="text-[10px] text-zinc-500">Tick {new Date(lastTickAt).toLocaleTimeString()}</span>
          ) : null}
        </div>
      </div>
      <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-500">
        <span className="font-medium text-amber-200/80">Simulation only</span> — no CLOB orders. Smart-money = matched-trade tape (Data API) vs UP/DOWN
        tokens, optional book +4¢ gate in engine. Not financial advice.
      </p>
      {globalErr ? <div className="mt-2 text-[11px] text-rose-300/90">{globalErr}</div> : null}
      {open ? (
        <div className="mt-3 space-y-2">
          <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
            <table className="w-full min-w-[720px] border-collapse text-left text-[11px] text-zinc-300">
              <thead className="bg-zinc-900/60 text-[9px] font-semibold uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-2 py-2">Market</th>
                  <th className="px-2 py-2">Slug</th>
                  <th className="px-2 py-2">UP mid</th>
                  <th className="px-2 py-2">DN mid</th>
                  <th className="px-2 py-2">Tape lean</th>
                  <th className="px-2 py-2">Ref</th>
                  <th className="px-2 py-2">Paper</th>
                  <th className="px-2 py-2">Open</th>
                  <th className="px-2 py-2">Ends</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-t border-zinc-800/40 hover:bg-zinc-900/30">
                    <td className="whitespace-nowrap px-2 py-1.5 font-medium text-zinc-200">{r.label}</td>
                    <td className="max-w-[10rem] truncate px-2 py-1.5 font-mono text-[10px] text-zinc-500" title={r.slug}>
                      {r.slug}
                    </td>
                    <td className="px-2 py-1.5 font-mono">{fmtCents(r.upMid)}</td>
                    <td className="px-2 py-1.5 font-mono">{fmtCents(r.downMid)}</td>
                    <td className="px-2 py-1.5">
                      <span className={r.lean === 'up' ? 'text-emerald-300/90' : r.lean === 'down' ? 'text-rose-300/90' : 'text-zinc-500'}>
                        {r.lean ? r.lean.toUpperCase() : '—'}
                      </span>
                      <span className="ml-1 text-zinc-500"> Δ{fmtN(r.tapeDiff)}</span>
                    </td>
                    <td className="px-2 py-1.5 font-mono text-zinc-400">{fmtCents(r.refHigh)}</td>
                    <td className="px-2 py-1.5">
                      {r.pos ? (
                        <span className="text-sky-200/90">
                          {r.pos.lane.toUpperCase()} @ {fmtCents(r.pos.entryMid)}
                        </span>
                      ) : (
                        <span className="text-zinc-500">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {r.openOrders.length ? (
                        <span className="font-mono text-amber-200/80">{r.openOrders.length}</span>
                      ) : (
                        <span className="text-zinc-600">0</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-zinc-500">
                      {r.endsInMs != null && Number.isFinite(r.endsInMs) ? `${Math.max(0, Math.round(r.endsInMs / 1000))}s` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between">
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-400">
              <input type="checkbox" checked={showOrders} onChange={(e) => setShowOrders(e.target.checked)} />
              Show open paper orders
            </label>
            <div className="text-[10px] text-zinc-600">Open orders are simulated ladder bids + TP sells.</div>
          </div>

          {showOrders ? (
            <div className="space-y-2">
              {rows.map((r) => (
                <div key={`o-${r.key}`} className="rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold text-zinc-200">{r.label}</div>
                    <div className="font-mono text-[10px] text-zinc-600">{r.openOrders.length ? `${r.openOrders.length} open` : '0 open'}</div>
                  </div>
                  {r.openOrders.length ? (
                    <div className="mt-1 flex flex-wrap gap-2">
                      {r.openOrders
                        .slice()
                        .sort((a, b) => b.price - a.price)
                        .slice(0, 16)
                        .map((o) => (
                          <span
                            key={o.id}
                            className={
                              o.side === 'buy'
                                ? 'rounded-full border border-emerald-900/40 bg-emerald-950/25 px-2 py-1 font-mono text-[10px] text-emerald-200/90'
                                : 'rounded-full border border-sky-900/40 bg-sky-950/20 px-2 py-1 font-mono text-[10px] text-sky-200/90'
                            }
                          >
                            {o.side.toUpperCase()} {o.lane.toUpperCase()} {(o.price * 100).toFixed(1)}¢×{o.shares.toFixed(0)}
                          </span>
                        ))}
                      {r.openOrders.length > 16 ? (
                        <span className="rounded-full border border-zinc-800/60 bg-black/20 px-2 py-1 font-mono text-[10px] text-zinc-500">
                          +{r.openOrders.length - 16} more
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-1 text-[10px] text-zinc-600">No open orders yet (needs a tape lean + ref high).</div>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          {rows.some((r) => r.err) ? (
            <div className="text-[10px] text-zinc-500">
              {rows
                .filter((r) => r.err)
                .map((r) => (
                  <div key={r.key}>
                    {r.label}: {r.err}
                  </div>
                ))}
            </div>
          ) : null}
          {eventTail.length > 0 ? (
            <div>
              <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Recent events</div>
              <ul className="mt-1 max-h-32 overflow-y-auto rounded-lg border border-zinc-800/50 bg-black/20 p-2 font-mono text-[10px] text-zinc-400">
                {eventTail.slice(-24).map((e, i) => (
                  <li key={`${e.t}-${e.key}-${e.kind}-${i}`}>
                    {new Date(e.t).toLocaleTimeString()} {e.key} {e.kind} {e.lane ? e.lane : ''} {e.detail}
                    {e.pnl01 != null && Number.isFinite(e.pnl01) ? ` pnl ${(e.pnl01 * 100).toFixed(1)}¢` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
