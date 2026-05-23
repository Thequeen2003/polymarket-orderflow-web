import type { ReactElement } from 'react';

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPnl(n: number | null | undefined): { text: string; className: string } {
  if (n == null || !Number.isFinite(n)) return { text: '—', className: 'text-zinc-100' };
  const sign = n >= 0 ? '+' : '';
  const text = `${sign}$${Math.abs(n).toFixed(2)}`;
  if (n > 0.005) return { text, className: 'text-emerald-300' };
  if (n < -0.005) return { text, className: 'text-rose-300' };
  return { text: '$0.00', className: 'text-zinc-300' };
}

function KpiTile(props: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
  ring?: string;
}): ReactElement {
  const { label, value, sub, valueClass, ring } = props;
  return (
    <div className={`min-w-0 flex-1 rounded-xl border bg-black/25 px-2.5 py-2.5 ring-1 sm:px-3 ${ring ?? 'border-zinc-800/60 ring-white/[0.03]'}`}>
      <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500 sm:text-[10px]">{label}</div>
      <div className={`mt-1 truncate font-mono text-[13px] font-semibold tabular-nums sm:text-sm ${valueClass ?? 'text-zinc-50'}`}>
        {value}
      </div>
      {sub ? <div className="mt-0.5 truncate text-[9px] text-zinc-600 sm:text-[10px]">{sub}</div> : null}
    </div>
  );
}

export type LiveTradingHudProps = {
  compact?: boolean;
  tradingReady: boolean | null;
  tradingVia?: 'bullpen' | 'clob' | null;
  balLoading?: boolean;
  balError?: string | null;
  cashUsd: number | null;
  equityUsd: number | null;
  totalUsd: number | null;
  unrealizedUsd: number | null;
  openOrdersCount?: number;
  onRefresh?: () => void;
  refreshing?: boolean;
};

export function LiveTradingHud(props: LiveTradingHudProps): ReactElement {
  const {
    compact = false,
    tradingReady,
    tradingVia,
    balLoading = false,
    balError,
    cashUsd,
    equityUsd,
    totalUsd,
    unrealizedUsd,
    openOrdersCount = 0,
    onRefresh,
    refreshing = false,
  } = props;

  const pnl = fmtPnl(unrealizedUsd);
  const viaLabel = tradingVia === 'bullpen' ? 'Bullpen' : tradingVia === 'clob' ? 'CLOB' : null;

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-800/40 bg-gradient-to-r from-rose-950/35 via-zinc-950/40 to-zinc-950/20 px-3 py-2.5 ring-1 ring-rose-500/10">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-500/50 bg-rose-950/50 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-rose-100">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-400" aria-hidden />
            Live
          </span>
          {tradingReady === true ? (
            <span className="rounded-full border border-emerald-800/40 bg-emerald-950/25 px-2 py-0.5 text-[10px] font-semibold text-emerald-200/90">
              API ready{viaLabel ? ` · ${viaLabel}` : ''}
            </span>
          ) : tradingReady === false ? (
            <span className="rounded-full border border-amber-800/40 bg-amber-950/25 px-2 py-0.5 text-[10px] font-semibold text-amber-100/90">
              Keys not configured
            </span>
          ) : (
            <span className="text-[10px] text-zinc-500">Checking API…</span>
          )}
          {openOrdersCount > 0 ? (
            <span className="rounded-full border border-zinc-700/50 bg-black/20 px-2 py-0.5 font-mono text-[10px] text-zinc-400">
              {openOrdersCount} open
            </span>
          ) : null}
        </div>
        {onRefresh ? (
          <button
            type="button"
            disabled={refreshing || balLoading}
            onClick={() => onRefresh()}
            className="shrink-0 rounded-lg border border-zinc-700/60 bg-black/30 px-2.5 py-1.5 text-[10px] font-semibold text-zinc-200 hover:bg-black/45 disabled:opacity-40"
          >
            {refreshing || balLoading ? 'Refreshing…' : 'Refresh wallet'}
          </button>
        ) : null}
      </div>

      {tradingReady === false ? (
        <div className="rounded-xl border border-amber-800/35 bg-amber-950/15 px-3 py-2 text-[11px] leading-relaxed text-amber-100/90">
          Add{' '}
          <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[10px] text-amber-200">POLYMARKET_PRIVATE_KEY</code> and{' '}
          <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[10px] text-amber-200">POLYMARKET_FUNDER</code> to{' '}
          <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[10px] text-amber-200">api/.env</code>, restart the API, then refresh.
          Orders you submit here will fail until the health check shows API ready.
        </div>
      ) : (
        <div className="rounded-xl border border-rose-900/25 bg-rose-950/10 px-3 py-2 text-[11px] leading-relaxed text-rose-100/85">
          Real USDC and outcome shares — every buy/sell hits Polymarket. Use{' '}
          <span className="font-semibold text-rose-50">Kill open orders</span> in the header strip if you need to flatten resting limits fast.
        </div>
      )}

      {balError ? (
        <div className="rounded-lg border border-amber-800/35 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-100/90">{balError}</div>
      ) : null}

      <div className={`grid gap-2 ${compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4'}`}>
        <KpiTile label="USDC" value={balLoading ? '…' : fmtUsd(cashUsd)} sub="Available to buy" ring="border-emerald-800/30 ring-emerald-500/10" />
        <KpiTile label="Positions" value={balLoading ? '…' : fmtUsd(equityUsd)} sub="Mark-to-market" />
        <KpiTile label="Total" value={balLoading ? '…' : fmtUsd(totalUsd)} sub="Cash + positions" ring="border-sky-800/30 ring-sky-500/10" />
        <KpiTile label="Unrealized" value={balLoading ? '…' : pnl.text} sub="This market" valueClass={pnl.className} />
      </div>
    </div>
  );
}
