import { useMemo, useState, type ReactElement } from 'react';

function fmtCents01(p01: number | null): string {
  if (p01 == null || !Number.isFinite(p01)) return '—';
  return `${Math.round(p01 * 100)}¢`;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function parsePositiveNumber(s: string): number | null {
  const n = Number(String(s).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function PolySimulatorTradePanel(props: {
  upLabel: string;
  downLabel: string;
  upMid: number | null;
  downMid: number | null;
}): ReactElement {
  const { upLabel, downLabel, upMid, downMid } = props;

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [lane, setLane] = useState<'up' | 'down'>('up');
  const [execMode, setExecMode] = useState<'market' | 'limit'>('market');
  const [unit, setUnit] = useState<'dollars' | 'shares'>('dollars');
  const [amount, setAmount] = useState('10');

  const px01 = lane === 'up' ? upMid : downMid;
  const px = px01 != null && Number.isFinite(px01) ? clamp01(px01) : null;

  const amt = parsePositiveNumber(amount);
  const estShares = useMemo(() => {
    if (amt == null) return null;
    if (unit === 'shares') return amt;
    if (px == null || px <= 0) return null;
    return amt / px;
  }, [amt, unit, px]);

  const costUsd = useMemo(() => {
    if (amt == null) return null;
    if (unit === 'dollars') return amt;
    if (px == null || estShares == null) return null;
    return estShares * px;
  }, [amt, unit, px, estShares]);

  const payoutUsd = useMemo(() => {
    if (estShares == null) return null;
    return estShares * 1;
  }, [estShares]);

  const profitUsd = useMemo(() => {
    if (payoutUsd == null || costUsd == null) return null;
    return payoutUsd - costUsd;
  }, [payoutUsd, costUsd]);

  const primaryLabel = `${side === 'buy' ? 'Buy' : 'Sell'} ${lane === 'up' ? upLabel : downLabel}`;

  return (
    <div className="rounded-[28px] border border-zinc-800/70 bg-[#0d1219] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.25)] ring-1 ring-white/[0.03]">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-semibold text-zinc-50">Trade</div>
        <div className="rounded-full border border-zinc-700/60 bg-black/20 p-1">
          <button
            type="button"
            onClick={() => setSide('buy')}
            className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-colors ${
              side === 'buy' ? 'bg-emerald-500/20 text-emerald-100' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Buy
          </button>
          <button
            type="button"
            onClick={() => setSide('sell')}
            className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-colors ${
              side === 'sell' ? 'bg-rose-500/20 text-rose-100' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Sell
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setLane('up')}
          className={`rounded-2xl border p-3 text-left transition-colors ${
            lane === 'up' ? 'border-emerald-500/40 bg-emerald-950/20' : 'border-zinc-800/60 bg-black/15 hover:bg-black/25'
          }`}
        >
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{upLabel}</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-zinc-50">{fmtCents01(upMid)}</div>
        </button>
        <button
          type="button"
          onClick={() => setLane('down')}
          className={`rounded-2xl border p-3 text-left transition-colors ${
            lane === 'down' ? 'border-rose-500/40 bg-rose-950/15' : 'border-zinc-800/60 bg-black/15 hover:bg-black/25'
          }`}
        >
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{downLabel}</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-zinc-50">{fmtCents01(downMid)}</div>
        </button>
      </div>

      <div className="mt-4 rounded-full border border-zinc-700/60 bg-black/20 p-1">
        <button
          type="button"
          onClick={() => setExecMode('market')}
          className={`rounded-full px-4 py-1.5 text-[11px] font-semibold transition-colors ${
            execMode === 'market' ? 'bg-zinc-900/60 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Market
        </button>
        <button
          type="button"
          onClick={() => setExecMode('limit')}
          className={`rounded-full px-4 py-1.5 text-[11px] font-semibold transition-colors ${
            execMode === 'limit' ? 'bg-zinc-900/60 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Limit
        </button>
      </div>

      <div className="mt-4">
        <div className="text-[11px] font-semibold text-zinc-300">Amount</div>
        <div className="mt-2 rounded-full border border-zinc-700/60 bg-black/20 p-1">
          <button
            type="button"
            onClick={() => setUnit('dollars')}
            className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors ${
              unit === 'dollars' ? 'bg-zinc-900/60 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Dollars
          </button>
          <button
            type="button"
            onClick={() => setUnit('shares')}
            className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors ${
              unit === 'shares' ? 'bg-zinc-900/60 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Shares
          </button>
        </div>

        <div className="mt-3 flex items-center gap-2 rounded-2xl border border-zinc-800/60 bg-black/15 px-3 py-2.5">
          <div className="font-mono text-[12px] text-zinc-400">{unit === 'dollars' ? '$' : ''}</div>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            className="min-h-[40px] w-full bg-transparent text-base font-semibold tabular-nums text-zinc-100 outline-none placeholder:text-zinc-600"
            placeholder={unit === 'dollars' ? '10' : '25'}
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {[
            { label: '+$10', v: '10' },
            { label: '+$25', v: '25' },
            { label: '+$50', v: '50' },
            { label: '+$100', v: '100' },
          ].map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                if (unit !== 'dollars') setUnit('dollars');
                setAmount(p.v);
              }}
              className="rounded-full border border-zinc-700/60 bg-black/15 px-3 py-1.5 text-[11px] font-semibold text-zinc-300 hover:bg-black/25"
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            className="rounded-full border border-zinc-700/60 bg-black/15 px-3 py-1.5 text-[11px] font-semibold text-zinc-300 hover:bg-black/25"
            title="Max (paper trading placeholder)"
          >
            Max
          </button>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-zinc-800/60 bg-black/15 p-3 text-[12px] text-zinc-300">
        <div className="flex items-center justify-between gap-3">
          <span className="text-zinc-500">Price per share</span>
          <span className="font-mono text-zinc-100">{fmtCents01(px)}</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-zinc-500">Est. shares</span>
          <span className="font-mono text-zinc-100">{estShares == null ? '—' : estShares.toFixed(2)}</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-zinc-500">Cost</span>
          <span className="font-mono text-zinc-100">{costUsd == null ? '—' : `$${costUsd.toFixed(2)}`}</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-zinc-500">Potential payout</span>
          <span className="font-mono text-zinc-100">{payoutUsd == null ? '—' : `$${payoutUsd.toFixed(2)}`}</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-zinc-500">Potential profit</span>
          <span className="font-mono text-emerald-200">{profitUsd == null ? '—' : `$${profitUsd.toFixed(2)}`}</span>
        </div>
      </div>

      <button
        type="button"
        className={`mt-4 w-full rounded-2xl px-4 py-3 text-sm font-bold text-black shadow-md transition-colors ${
          side === 'buy' ? 'bg-emerald-400 hover:bg-emerald-300' : 'bg-rose-400 hover:bg-rose-300'
        }`}
        title={execMode === 'limit' ? 'Limit mode UI placeholder (not wired to execution yet)' : 'Market mode UI placeholder (not wired to execution yet)'}
      >
        {primaryLabel}
      </button>

      <div className="mt-3 text-center text-[11px] text-zinc-500">Paper trading only — no real money</div>
      <div className="mt-1 text-center text-[11px] text-zinc-600">Ready for real money? Trade on Polymarket</div>
    </div>
  );
}

