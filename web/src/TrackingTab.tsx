import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { ApiErr, ApiOk } from './lib/api';
import { tradeAvgEntry, tradeBalanceAllowance, tradeCancelOrder, tradeOpenOrders, tradeUpdateBalanceAllowance } from './lib/api';

function isOk<T>(r: ApiOk<T> | ApiErr): r is ApiOk<T> {
  return r.ok === true;
}

function fmt01(p: number | null): string {
  if (p == null || !Number.isFinite(p) || p <= 0) return '—';
  return `${(p * 100).toFixed(1)}¢`;
}

function pickOrderId(o: unknown): string | null {
  const r = o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  const id = (typeof r?.orderID === 'string' && r.orderID) || (typeof r?.order_id === 'string' && r.order_id) || '';
  return id.trim() ? id.trim() : null;
}

function pickTokenId(o: unknown): string | null {
  const r = o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  const t = (typeof r?.tokenID === 'string' && r.tokenID) || (typeof r?.token_id === 'string' && r.token_id) || '';
  return t.trim() ? t.trim() : null;
}

function pickSide(o: unknown): string {
  const r = o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  const s = (typeof r?.side === 'string' && r.side) || (typeof r?.order_side === 'string' && r.order_side) || '';
  return s ? String(s).toUpperCase() : '—';
}

function pickPrice01(o: unknown): number | null {
  const r = o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  const raw = r?.price;
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(n) ? n : null;
}

function pickSize(o: unknown): number | null {
  const r = o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  const raw = r?.original_size ?? r?.size ?? r?.remaining_size ?? null;
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(n) ? n : null;
}

export function TrackingTab(props: { upToken: string; downToken: string }): ReactElement {
  const { upToken, downToken } = props;
  const tokens = useMemo(() => [upToken, downToken].filter((t) => t && t.trim()), [upToken, downToken]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [orders, setOrders] = useState<unknown[]>([]);
  const [usdc, setUsdc] = useState<string | null>(null);
  const [upPos, setUpPos] = useState<{ shares: number | null; avgEntry: number | null }>({ shares: null, avgEntry: null });
  const [downPos, setDownPos] = useState<{ shares: number | null; avgEntry: number | null }>({ shares: null, avgEntry: null });

  const refresh = async () => {
    setBusy(true);
    setErr(null);
    try {
      const [bal, o, up, down] = await Promise.all([
        tradeBalanceAllowance({ assetType: 'collateral' }),
        tradeOpenOrders(tokens.length === 1 ? { tokenId: tokens[0] } : undefined),
        upToken ? tradeAvgEntry(upToken) : Promise.resolve({ ok: true, data: { tokenId: '', avgEntry: null, shares: 0 } } as ApiOk<any>),
        downToken ? tradeAvgEntry(downToken) : Promise.resolve({ ok: true, data: { tokenId: '', avgEntry: null, shares: 0 } } as ApiOk<any>),
      ]);

      if (isOk(bal)) setUsdc(bal.data.balance);
      else setUsdc(null);

      if (isOk(o)) setOrders(o.data.orders ?? []);
      else {
        setOrders([]);
        setErr(`${o.error}${o.details ? ` · ${JSON.stringify(o.details)}` : ''}`);
      }

      if (isOk(up)) setUpPos({ shares: up.data.shares ?? null, avgEntry: up.data.avgEntry ?? null });
      else setUpPos({ shares: null, avgEntry: null });
      if (isOk(down)) setDownPos({ shares: down.data.shares ?? null, avgEntry: down.data.avgEntry ?? null });
      else setDownPos({ shares: null, avgEntry: null });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upToken, downToken]);

  return (
    <div className="mt-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-zinc-800/50 bg-zinc-900/20 p-4 ring-1 ring-white/[0.02]">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-zinc-100">Tracking</div>
          <div className="mt-1 text-xs leading-relaxed text-zinc-500">
            Your exposure snapshot: cash, positions, and open orders (live).
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void refresh()}
            className="rounded-xl border border-zinc-700/50 bg-black/20 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-black/30 disabled:opacity-40"
          >
            Refresh
          </button>
          <button
            type="button"
            disabled={busy || tokens.length === 0}
            onClick={() => void tradeUpdateBalanceAllowance({ assetType: 'collateral' })}
            className="rounded-xl border border-zinc-700/50 bg-black/20 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-black/30 disabled:opacity-40"
            title="Refresh CLOB cached balances (helps when sells say balance is stale)"
          >
            Sync balances
          </button>
        </div>
      </div>

      {err ? (
        <div className="rounded-xl border border-rose-900/35 bg-rose-950/15 px-3 py-2 text-[12px] text-rose-100">
          {err}
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/40 p-4 ring-1 ring-white/[0.02]">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Cash (USDC)</div>
          <div className="mt-2 font-mono text-[16px] font-bold text-zinc-100">{usdc ?? '—'}</div>
          <div className="mt-2 text-[11px] text-zinc-500">This is what Market buys spend from.</div>
        </div>

        <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/40 p-4 ring-1 ring-white/[0.02]">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Up token</div>
          <div className="mt-2 text-[12px] text-zinc-300">{upToken ? `${upToken.slice(0, 8)}…${upToken.slice(-6)}` : '—'}</div>
          <div className="mt-2 flex items-center justify-between text-[12px] text-zinc-400">
            <span>Shares</span>
            <span className="font-mono text-zinc-100">{upPos.shares == null ? '—' : upPos.shares.toFixed(4)}</span>
          </div>
          <div className="mt-2 flex items-center justify-between text-[12px] text-zinc-400">
            <span>Avg entry</span>
            <span className="font-mono text-zinc-100">{fmt01(upPos.avgEntry)}</span>
          </div>
        </div>

        <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/40 p-4 ring-1 ring-white/[0.02]">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Down token</div>
          <div className="mt-2 text-[12px] text-zinc-300">{downToken ? `${downToken.slice(0, 8)}…${downToken.slice(-6)}` : '—'}</div>
          <div className="mt-2 flex items-center justify-between text-[12px] text-zinc-400">
            <span>Shares</span>
            <span className="font-mono text-zinc-100">{downPos.shares == null ? '—' : downPos.shares.toFixed(4)}</span>
          </div>
          <div className="mt-2 flex items-center justify-between text-[12px] text-zinc-400">
            <span>Avg entry</span>
            <span className="font-mono text-zinc-100">{fmt01(downPos.avgEntry)}</span>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/40 p-4 ring-1 ring-white/[0.02]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-zinc-100">Open orders</div>
            <div className="mt-1 text-[11px] text-zinc-500">Resting limit orders that can still fill.</div>
          </div>
          <div className="text-[11px] font-mono text-zinc-500">{orders.length} orders</div>
        </div>

        {orders.length === 0 ? (
          <div className="mt-3 rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-3 text-[12px] text-zinc-500">
            None.
          </div>
        ) : (
          <div className="mt-3 overflow-auto rounded-xl border border-zinc-800/50">
            <div className="grid min-w-[720px] grid-cols-[160px_130px_90px_90px_1fr_120px] gap-2 border-b border-zinc-800/50 bg-black/20 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              <span>Order ID</span>
              <span>Token</span>
              <span>Side</span>
              <span className="text-right">Price</span>
              <span className="text-right">Size</span>
              <span className="text-right">Action</span>
            </div>
            {orders.slice(0, 200).map((o, idx) => {
              const oid = pickOrderId(o);
              const tok = pickTokenId(o);
              const px = pickPrice01(o);
              const sz = pickSize(o);
              return (
                <div
                  key={`${oid ?? 'row'}-${idx}`}
                  className="grid min-w-[720px] grid-cols-[160px_130px_90px_90px_1fr_120px] items-center gap-2 px-3 py-2 text-[12px] text-zinc-200"
                >
                  <span className="truncate font-mono text-[11px] text-zinc-300">{oid ?? '—'}</span>
                  <span className="truncate font-mono text-[11px] text-zinc-500">{tok ? `${tok.slice(0, 6)}…${tok.slice(-4)}` : '—'}</span>
                  <span className="text-[11px] font-semibold">{pickSide(o)}</span>
                  <span className="text-right font-mono text-[11px]">{px == null ? '—' : `${(px * 100).toFixed(1)}¢`}</span>
                  <span className="text-right font-mono text-[11px]">{sz == null ? '—' : sz.toFixed(4)}</span>
                  <span className="text-right">
                    <button
                      type="button"
                      disabled={!oid}
                      onClick={async () => {
                        if (!oid) return;
                        await tradeCancelOrder(oid);
                        void refresh();
                      }}
                      className="rounded-lg border border-zinc-700/60 bg-black/20 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-black/30 disabled:opacity-40"
                    >
                      Cancel
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

