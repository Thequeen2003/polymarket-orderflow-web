import { useEffect, useId, useMemo, useState, type ReactElement } from 'react';

type Candle = { t: number; c: number };

type Verdict = 'LONG' | 'SHORT' | 'WAIT';

function sma(xs: number[], len: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (i + 1 < len) {
      out.push(null);
      continue;
    }
    let s = 0;
    for (let j = 0; j < len; j++) s += xs[i - j];
    out.push(s / len);
  }
  return out;
}

function parseKlines(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) return [];
  const out: Candle[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const t = Number(row[0]);
    const c = Number(row[4]);
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    out.push({ t, c });
  }
  return out;
}

/** Price vs MA stack + micro slope → discretionary label only */
function verdictFromSeries(closes: number[], ma20: (number | null)[], ma50: (number | null)[]): Verdict {
  const n = closes.length;
  if (n < 55) return 'WAIT';
  const last = closes[n - 1]!;
  const m20 = ma20[n - 1];
  const m50 = ma50[n - 1];
  const m20p = ma20[n - 4];
  const m50p = ma50[n - 4];
  if (m20 == null || m50 == null || m20p == null || m50p == null) return 'WAIT';

  const slope3 = (last - closes[n - 4]!) / Math.max(1e-12, closes[n - 4]!);
  const ma20Rising = m20 >= m20p * 1.0002;
  const ma20Falling = m20 <= m20p * 0.9998;

  if (last > m20 && m20 > m50 && slope3 >= -0.0005 && ma20Rising) return 'LONG';
  if (last < m20 && m20 < m50 && slope3 <= 0.0005 && ma20Falling) return 'SHORT';
  return 'WAIT';
}

export function BtcUsdDecisionChart(): ReactElement {
  const gradId = useId().replace(/:/g, '');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const W = 640;
  const H = 220;
  const pad = 28;

  useEffect(() => {
    let alive = true;
    const ac = new AbortController();

    async function pull(): Promise<void> {
      try {
        const r = await fetch(
          'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=120',
          { signal: ac.signal, cache: 'no-store' },
        );
        if (!r.ok || !alive) return;
        const raw = (await r.json()) as unknown;
        const c = parseKlines(raw);
        if (alive) {
          setCandles(c);
          setErr(null);
        }
      } catch {
        if (alive) {
          setErr('Could not load BTCUSDT klines (network/CORS).');
          setCandles([]);
        }
      } finally {
        if (alive) setLoading(false);
      }
    }

    void pull();
    const id = window.setInterval(() => void pull(), 45_000);
    return () => {
      alive = false;
      ac.abort();
      window.clearInterval(id);
    };
  }, []);

  const { verdict, lastClose, lastM20, lastM50, pathClose, pathMa20, pathMa50 } = useMemo(() => {
    const closes = candles.map((c) => c.c);
    const ma20 = sma(closes, 20);
    const ma50 = sma(closes, 50);
    let v: Verdict = 'WAIT';
    let pMin = 0;
    let pMax = 1;
    let lastClose = 0;
    let lastM20: number | null = null;
    let lastM50: number | null = null;
    let pathClose = '';
    let pathMa20 = '';
    let pathMa50 = '';

    const innerW = W - pad * 2;
    const innerH = H - pad * 2;

    if (closes.length >= 55) {
      const n = closes.length;
      lastClose = closes[n - 1]!;
      lastM20 = ma20[n - 1]!;
      lastM50 = ma50[n - 1]!;
      v = verdictFromSeries(closes, ma20, ma50);

      const from = 49;
      const slice = closes.slice(from);
      const m20s = ma20.slice(from).filter((x): x is number => x != null);
      const m50s = ma50.slice(from).filter((x): x is number => x != null);
      const all = [...slice, ...m20s, ...m50s];
      pMin = Math.min(...all) * 0.9992;
      pMax = Math.max(...all) * 1.0008;

      const xy = (i: number, price: number): string => {
        const rng = Math.max(1e-9, pMax - pMin);
        const x = pad + (i / Math.max(1, n - 1)) * innerW;
        const y = pad + innerH - ((price - pMin) / rng) * innerH;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      };

      pathClose = closes.map((p, i) => xy(i, p)).join(' ');
      const pts20: string[] = [];
      const pts50: string[] = [];
      for (let i = 19; i < n; i++) {
        const m = ma20[i];
        if (m != null) pts20.push(xy(i, m));
      }
      for (let i = 49; i < n; i++) {
        const m = ma50[i];
        if (m != null) pts50.push(xy(i, m));
      }
      pathMa20 = pts20.join(' ');
      pathMa50 = pts50.join(' ');
    }

    return { verdict: v, lastClose, lastM20, lastM50, pathClose, pathMa20, pathMa50 };
  }, [candles]);

  const fillPoints =
    pathClose.length > 0 ? `${pathClose} ${W - pad},${H - pad} ${pad},${H - pad}` : '';

  const verdictClass =
    verdict === 'LONG'
      ? 'border-emerald-500/55 bg-emerald-950/35 text-emerald-200'
      : verdict === 'SHORT'
        ? 'border-rose-500/55 bg-rose-950/35 text-rose-200'
        : 'border-zinc-600/60 bg-zinc-900/40 text-zinc-200';

  return (
    <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/60 p-4 ring-1 ring-cyan-500/10 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">BTC / USDT · long or short?</div>
          <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-zinc-500">
            Binance spot <span className="font-mono text-zinc-400">BTCUSDT</span>, 15m closes vs MA20 / MA50. Use with the TradingView panel — this is a fast
            structural read, not a trade signal service.
          </p>
        </div>
        <div
          className={`rounded-xl border px-4 py-2 text-center font-mono text-lg font-black tracking-tight ${verdictClass}`}
          title="Heuristic from price vs moving averages only"
        >
          {loading ? '…' : verdict}
        </div>
      </div>

      {err ? (
        <p className="mt-3 text-[12px] text-rose-300">{err}</p>
      ) : (
        <div className="mt-4 w-full overflow-x-auto">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-auto w-full min-w-[320px] max-w-[640px]"
            role="img"
            aria-label="BTC USDT close price with 20 and 50 period moving averages"
          >
            <defs>
              <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={verdict === 'LONG' ? 'rgb(16 185 129 / 0.12)' : verdict === 'SHORT' ? 'rgb(244 63 94 / 0.12)' : 'rgb(113 113 122 / 0.08)'} />
                <stop offset="100%" stopColor="rgb(0 0 0 / 0)" />
              </linearGradient>
            </defs>
            <rect x={0} y={0} width={W} height={H} fill="rgb(9 9 11 / 0.5)" rx={8} />
            {pathClose ? (
              <>
                <polyline
                  fill="none"
                  stroke="rgb(228 228 231 / 0.25)"
                  strokeWidth="1"
                  points={`${pad},${H - pad} ${W - pad},${H - pad}`}
                />
                <polygon fill={`url(#${gradId})`} stroke="none" points={fillPoints} />
                <polyline fill="none" stroke="rgb(244 244 245)" strokeWidth="2" strokeLinejoin="round" points={pathClose} />
                <polyline fill="none" stroke="rgb(251 191 36 / 0.85)" strokeWidth="1.5" strokeDasharray="4 3" points={pathMa20} />
                <polyline fill="none" stroke="rgb(167 139 250 / 0.9)" strokeWidth="1.5" strokeDasharray="6 4" points={pathMa50} />
              </>
            ) : null}
          </svg>
          <div className="mt-2 flex flex-wrap gap-4 font-mono text-[10px] text-zinc-500">
            <span>
              <span className="text-zinc-300">●</span> Close
            </span>
            <span>
              <span className="text-amber-400">- -</span> MA20
            </span>
            <span>
              <span className="text-violet-400">- -</span> MA50
            </span>
            {lastClose > 0 ? (
              <span className="text-zinc-400">
                Last ${lastClose.toLocaleString(undefined, { maximumFractionDigits: 2 })} · MA20{' '}
                {lastM20 != null ? `$${lastM20.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'} · MA50{' '}
                {lastM50 != null ? `$${lastM50.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
              </span>
            ) : null}
          </div>
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">
        <span className="font-medium text-zinc-500">LONG</span> ≈ closes above rising short trend (price &gt; MA20 &gt; MA50, MA20 tilted up).{' '}
        <span className="font-medium text-zinc-500">SHORT</span> ≈ mirror bear stack.{' '}
        <span className="font-medium text-zinc-500">WAIT</span> when MAs cross or price chops between — avoids forcing a side.
      </p>
    </div>
  );
}
