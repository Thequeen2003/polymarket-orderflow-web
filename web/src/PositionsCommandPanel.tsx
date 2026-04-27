import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { ApiErr, ApiOk } from './lib/api';
import { clobBooks } from './lib/api';
import { midPrice } from './bookLevels';
import { getPaperPosition, loadPaperAccount, paperTrade, type PaperAccount } from './paperTrading';
import { notifyPaperAccountUpdated } from './paperAccountSync';
import { appendTradeHistory, loadTradeHistory, type TradeHistoryRow } from './tradeHistory';
import { playTradeClick, playTradeError, playTradeFill } from './tradeSounds';

function isOk<T>(res: ApiOk<T> | ApiErr): res is ApiOk<T> {
  return res.ok === true;
}

function fmtCents(p01: number | null): string {
  return p01 == null || !Number.isFinite(p01) ? '—' : `${(p01 * 100).toFixed(1)}¢`;
}

function windowFromSlug(slug: string): string | null {
  const m = slug.trim().match(/-(\d{9,})$/);
  if (!m) return null;
  const sec = Number(m[1]);
  if (!Number.isFinite(sec)) return null;
  try {
    return new Date(sec * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return null;
  }
}

function metaForToken(history: TradeHistoryRow[], token: string): { slug?: string; title?: string; label?: string } {
  for (const r of history) {
    if (r.token !== token) continue;
    if (r.marketSlug || r.marketTitle) {
      return { slug: r.marketSlug, title: r.marketTitle, label: r.label };
    }
  }
  for (const r of history) {
    if (r.token === token && r.label) return { label: r.label };
  }
  return {};
}

function laneFromLabel(label: string | undefined): 'up' | 'down' {
  const u = (label ?? '').toUpperCase();
  if (u.includes('DOWN')) return 'down';
  return 'up';
}

export type PositionsCommandPanelProps = {
  open: boolean;
  onClose: () => void;
  selectedSlug: string;
  booksFetchedAt: number | null;
  onNavigate: (slug: string, lane: 'up' | 'down') => void;
};

type RowModel = {
  token: string;
  shares: number;
  avg01: number | null;
  slug?: string;
  title?: string;
  outcomeLabel?: string;
  mid01: number | null;
  /** vs previous poll */
  momentum: 'up' | 'down' | 'flat';
};

type ExecPulse = 'idle' | 'sending' | 'filled' | 'failed';

/**
 * Global paper positions + live CLOB mids — fixed left command tower (no drag).
 * Keyboard: X exit selected row, Shift+X close all (when panel is open, not typing in an input).
 */
export function PositionsCommandPanel(props: PositionsCommandPanelProps): ReactElement {
  const { open, onClose, selectedSlug, booksFetchedAt, onNavigate } = props;
  const [paper, setPaper] = useState<PaperAccount>(() => loadPaperAccount());
  const [history, setHistory] = useState<TradeHistoryRow[]>(() => loadTradeHistory());
  const [mids, setMids] = useState<Record<string, number | null>>({});
  const prevMidRef = useRef<Record<string, number>>({});
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [busyAll, setBusyAll] = useState(false);
  const [execPulse, setExecPulse] = useState<ExecPulse>('idle');
  const [flash, setFlash] = useState<string | null>(null);

  const refreshLocal = useCallback(() => {
    setPaper(loadPaperAccount());
    setHistory(loadTradeHistory());
  }, []);

  useEffect(() => {
    if (!open) return;
    refreshLocal();
    const id = window.setInterval(refreshLocal, 1000);
    return () => window.clearInterval(id);
  }, [open, refreshLocal]);

  const rows = useMemo((): RowModel[] => {
    const out: RowModel[] = [];
    const entries = Object.entries(paper.positionsByToken ?? {});
    for (const [token] of entries) {
      const p = getPaperPosition(paper, token);
      if (p.shares <= 1e-6) continue;
      const m = metaForToken(history, token);
      const mid01 = mids[token] ?? null;
      const prev = prevMidRef.current[token];
      let momentum: RowModel['momentum'] = 'flat';
      if (mid01 != null && prev != null && Number.isFinite(prev)) {
        if (mid01 > prev + 1e-6) momentum = 'up';
        else if (mid01 < prev - 1e-6) momentum = 'down';
      }
      out.push({
        token,
        shares: p.shares,
        avg01: p.avgCost01,
        slug: m.slug,
        title: m.title,
        outcomeLabel: m.label,
        mid01,
        momentum,
      });
    }
    out.sort((a, b) => Math.abs(b.shares) - Math.abs(a.shares));
    return out.slice(0, 14);
  }, [paper, history, mids]);

  useEffect(() => {
    for (const r of rows) {
      if (r.mid01 != null && Number.isFinite(r.mid01)) prevMidRef.current[r.token] = r.mid01;
    }
  }, [rows]);

  const positionTokenKey = useMemo(() => {
    const keys = Object.keys(paper.positionsByToken ?? {});
    return keys
      .filter((k) => getPaperPosition(paper, k).shares > 1e-6)
      .sort()
      .join(',');
  }, [paper]);

  useEffect(() => {
    if (!open) return;
    const tokens = positionTokenKey.split(',').filter(Boolean);
    if (tokens.length === 0) {
      setMids({});
      return;
    }
    let cancelled = false;
    const tick = async () => {
      const res = await clobBooks(tokens);
      if (cancelled) return;
      if (!isOk(res)) return;
      const next: Record<string, number | null> = {};
      for (const e of res.data) {
        if (e.error) next[e.token] = null;
        else next[e.token] = midPrice(e.book);
      }
      setMids((prev) => ({ ...prev, ...next }));
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, positionTokenKey]);

  const openUnrealizedUsd = useMemo(() => {
    let s = 0;
    for (const r of rows) {
      const mid = r.mid01;
      const avg = r.avg01;
      if (mid == null || avg == null || !Number.isFinite(mid) || !Number.isFinite(avg)) continue;
      s += r.shares * (mid - avg);
    }
    return s;
  }, [rows]);

  const execStatus = useMemo(() => {
    if (booksFetchedAt == null) return { label: 'Delayed' as const, tone: 'slow' as const };
    const age = Date.now() - booksFetchedAt;
    if (age < 2500) return { label: 'Live' as const, tone: 'live' as const };
    if (age < 12_000) return { label: 'Slow' as const, tone: 'slow' as const };
    return { label: 'Delayed' as const, tone: 'slow' as const };
  }, [booksFetchedAt]);

  const pushFlash = useCallback((msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 3200);
  }, []);

  const exitToken = useCallback(
    async (token: string, shares: number, meta: { slug?: string; title?: string; label?: string }) => {
      playTradeClick();
      setExecPulse('sending');
      setBusyToken(token);
      try {
        const res = await clobBooks([token]);
        let mid01: number | null = null;
        if (isOk(res) && res.data[0] && !res.data[0].error) mid01 = midPrice(res.data[0].book);
        if (mid01 == null || !Number.isFinite(mid01) || mid01 <= 0 || mid01 >= 1) {
          mid01 = 0.5;
          pushFlash('No book mid — paper exit @ 50¢ synthetic');
        }
        const acct = loadPaperAccount();
        const held = getPaperPosition(acct, token).shares;
        const sellQty = Math.min(shares, held);
        const r = paperTrade({ account: acct, tokenId: token, side: 'sell', shares: sellQty, price01: mid01 });
        if (!r.ok) {
          playTradeError();
          setExecPulse('failed');
          pushFlash(r.error);
          return;
        }
        appendTradeHistory({
          mode: 'paper',
          exec: 'market',
          side: 'sell',
          token,
          label: meta.label ?? '—',
          marketSlug: meta.slug,
          marketTitle: meta.title,
          price01: r.fill.price01,
          shares: r.fill.shares,
          usdCents: Math.abs(r.fill.usdCents),
          status: 'filled',
        });
        notifyPaperAccountUpdated();
        refreshLocal();
        playTradeFill();
        setExecPulse('filled');
        window.setTimeout(() => setExecPulse('idle'), 900);
        pushFlash(`Exited · ${r.fill.shares.toFixed(2)} sh @ ${(r.fill.price01 * 100).toFixed(1)}¢`);
      } catch {
        playTradeError();
        setExecPulse('failed');
        pushFlash('Exit failed');
      } finally {
        setBusyToken(null);
      }
    },
    [pushFlash, refreshLocal],
  );

  const closeAll = useCallback(async () => {
    setBusyAll(true);
    setExecPulse('sending');
    try {
      let guard = 0;
      while (guard++ < 32) {
        const acct = loadPaperAccount();
        const next = Object.entries(acct.positionsByToken ?? {})
          .map(([tok]) => ({ tok, p: getPaperPosition(acct, tok) }))
          .find((x) => x.p.shares > 1e-6);
        if (!next) break;
        const hist = loadTradeHistory();
        const m = metaForToken(hist, next.tok);
        await exitToken(next.tok, next.p.shares, { slug: m.slug, title: m.title, label: m.label });
      }
      setExecPulse('filled');
      window.setTimeout(() => setExecPulse('idle'), 900);
    } finally {
      setBusyAll(false);
    }
  }, [exitToken]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

      if (e.key === 'x' || e.key === 'X') {
        if (e.shiftKey) {
          e.preventDefault();
          void closeAll();
          return;
        }
        if (selectedToken) {
          const row = rows.find((r) => r.token === selectedToken);
          if (row && !busyToken && !busyAll) {
            e.preventDefault();
            void exitToken(row.token, row.shares, {
              slug: row.slug,
              title: row.title,
              label: row.outcomeLabel,
            });
          }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, closeAll, selectedToken, rows, busyToken, busyAll, exitToken]);

  useEffect(() => {
    if (rows.length === 0) {
      setSelectedToken(null);
      return;
    }
    if (!selectedToken || !rows.some((r) => r.token === selectedToken)) {
      setSelectedToken(rows[0]!.token);
    }
  }, [rows, selectedToken]);

  return (
    <div
      className={`fixed inset-y-0 left-0 z-[132] flex w-[min(400px,100vw)] flex-col border-r border-cyan-900/40 bg-zinc-950 shadow-[12px_0_40px_rgba(0,0,0,0.45)] transition-transform duration-200 ease-out ${
        open ? 'translate-x-0' : '-translate-x-full pointer-events-none'
      }`}
      aria-hidden={!open}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-800/80 px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-cyan-500/90">Positions</div>
          <div className="truncate text-[13px] font-semibold text-zinc-100">Command center</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-lg border border-zinc-600/60 bg-zinc-900/80 px-3 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-800/90"
          title="Close (Esc)"
        >
          Close
        </button>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden px-3 py-2">
        <div className="min-w-0 shrink-0 space-y-2 rounded-xl border border-zinc-800/70 bg-black/30 p-2.5">
          <div className="grid min-w-0 grid-cols-[1fr_auto] items-start gap-x-3 gap-y-1">
            <div className="min-w-0">
              <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Open P/L (paper)</div>
              <div
                className={`truncate font-mono text-base font-bold tabular-nums leading-tight sm:text-lg ${
                  openUnrealizedUsd >= 0 ? 'text-emerald-300' : 'text-rose-300'
                }`}
                title={`${openUnrealizedUsd >= 0 ? '+' : ''}$${openUnrealizedUsd.toFixed(2)}`}
              >
                {openUnrealizedUsd >= 0 ? '+' : ''}
                ${openUnrealizedUsd.toFixed(2)}
              </div>
              <div
                className="truncate text-[9px] text-zinc-500"
                title={`Realized ${(paper.realizedPnlUsdCents / 100) >= 0 ? '+' : '-'}$${Math.abs(paper.realizedPnlUsdCents / 100).toFixed(2)}`}
              >
                Realized session{' '}
                <span className="font-mono tabular-nums text-zinc-400">
                  {(paper.realizedPnlUsdCents / 100) >= 0 ? '+' : '-'}${Math.abs(paper.realizedPnlUsdCents / 100).toFixed(2)}
                </span>
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-[9px] font-semibold uppercase text-zinc-500">Active</div>
              <div className="font-mono text-lg font-bold tabular-nums text-zinc-100 sm:text-xl">{rows.length}</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                execStatus.tone === 'live'
                  ? 'bg-emerald-500/20 text-emerald-200'
                  : execStatus.tone === 'slow'
                    ? 'bg-amber-500/15 text-amber-100'
                    : 'bg-rose-500/15 text-rose-100'
              }`}
            >
              {execStatus.label}
            </span>
            <span className="text-[9px] text-zinc-500">Book age → feed health</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                execPulse === 'sending' ? 'animate-pulse bg-amber-400' : execPulse === 'filled' ? 'bg-emerald-400' : execPulse === 'failed' ? 'bg-rose-500' : 'bg-zinc-600'
              }`}
            />
            <span className="text-[10px] font-medium text-zinc-400">
              {execPulse === 'sending' ? 'SENDING…' : execPulse === 'filled' ? 'FILLED' : execPulse === 'failed' ? 'FAILED' : 'READY'}
            </span>
          </div>
          <button
            type="button"
            disabled={busyAll || rows.length === 0}
            onClick={() => void closeAll()}
            className="w-full rounded-lg border border-rose-700/50 bg-rose-950/30 py-2 text-[11px] font-bold text-rose-100 hover:bg-rose-950/50 disabled:opacity-40"
          >
            Close all positions
          </button>
          <p className="text-[9px] leading-snug text-zinc-600">
            Paper only · exits hit CLOB mid then reconcile. Keys: <span className="font-mono text-zinc-400">X</span> exit selected ·{' '}
            <span className="font-mono text-zinc-400">Shift+X</span> close all
          </p>
        </div>

        {flash ? (
          <div className="min-w-0 shrink-0 break-words rounded-lg border border-cyan-800/40 bg-cyan-950/25 px-2.5 py-1.5 text-left text-[11px] leading-snug text-cyan-50">
            {flash}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain pr-0.5">
          {rows.length === 0 ? (
            <div className="rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-6 text-center text-[12px] text-zinc-500">No open paper positions.</div>
          ) : (
            <ul className="space-y-1.5">
              {rows.map((r) => {
                const slug = r.slug ?? '';
                const win = slug ? windowFromSlug(slug) : null;
                const titleLine = r.title?.trim() || slug || `${r.token.slice(0, 6)}…`;
                const sub = [win ? win : null, slug ? slug.replace(/^btc-updown-/, 'BTC ') : null].filter(Boolean).join(' · ');
                const unreal =
                  r.mid01 != null && r.avg01 != null ? r.shares * (r.mid01 - r.avg01) : null;
                const slugMatchesPage = Boolean(selectedSlug && slug && selectedSlug === slug);
                return (
                  <li key={r.token}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setSelectedToken(r.token);
                        if (slug) onNavigate(slug, laneFromLabel(r.outcomeLabel));
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        setSelectedToken(r.token);
                        if (slug) onNavigate(slug, laneFromLabel(r.outcomeLabel));
                      }}
                      className={`flex min-w-0 w-full flex-col gap-1 rounded-xl border px-2.5 py-2 text-left transition-colors ${
                        r.token === selectedToken
                          ? 'border-cyan-500/60 bg-cyan-950/20 ring-1 ring-cyan-500/25'
                          : slugMatchesPage
                            ? 'border-zinc-600/80 bg-zinc-900/40'
                            : 'border-zinc-800/70 bg-black/25 hover:border-zinc-700/80'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-1">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[11px] font-semibold text-zinc-100">{titleLine}</div>
                          {sub ? <div className="truncate font-mono text-[9px] text-zinc-500">{sub}</div> : null}
                        </div>
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold ${
                            laneFromLabel(r.outcomeLabel) === 'up' ? 'bg-emerald-500/20 text-emerald-100' : 'bg-rose-500/20 text-rose-100'
                          }`}
                        >
                          {(r.outcomeLabel ?? '?').toUpperCase().slice(0, 4)}
                        </span>
                      </div>
                      <div className="grid min-w-0 grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-zinc-400">
                        <div className="min-w-0 text-zinc-500">Entry</div>
                        <div
                          className="min-w-0 truncate text-right font-mono tabular-nums text-zinc-200"
                          title={`${r.shares.toFixed(2)} sh @ ${fmtCents(r.avg01)}`}
                        >
                          {r.shares.toFixed(1)} sh @ {fmtCents(r.avg01)}
                        </div>
                        <div className="flex min-w-0 items-center gap-1 text-zinc-500">
                          <span
                            className={
                              r.momentum === 'up' ? 'text-emerald-400' : r.momentum === 'down' ? 'text-rose-400' : 'text-zinc-600'
                            }
                            aria-hidden
                          >
                            {r.momentum === 'up' ? '▲' : r.momentum === 'down' ? '▼' : '◇'}
                          </span>
                          Mid
                        </div>
                        <div className="min-w-0 truncate text-right font-mono tabular-nums text-zinc-100" title={fmtCents(r.mid01)}>
                          {fmtCents(r.mid01)}
                        </div>
                      </div>
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <span
                          className={`min-w-0 flex-1 truncate font-mono text-[11px] font-bold tabular-nums ${
                            unreal == null ? 'text-zinc-500' : unreal >= 0 ? 'text-emerald-300' : 'text-rose-300'
                          }`}
                          title={unreal == null ? undefined : `${unreal >= 0 ? '+' : ''}$${unreal.toFixed(2)}`}
                        >
                          {unreal == null ? 'P/L —' : `${unreal >= 0 ? '+' : ''}$${unreal.toFixed(2)}`}
                        </span>
                        <div className="flex shrink-0 gap-1">
                          <button
                            type="button"
                            disabled={busyToken === r.token || busyAll}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedToken(r.token);
                              void exitToken(r.token, r.shares, {
                                slug: r.slug,
                                title: r.title,
                                label: r.outcomeLabel,
                              });
                            }}
                            className="rounded-md border border-rose-600/50 bg-rose-950/40 px-2 py-1 text-[10px] font-bold text-rose-100 hover:bg-rose-950/60 disabled:opacity-40"
                          >
                            EXIT
                          </button>
                          <button
                            type="button"
                            disabled
                            title="Bracket / quick TP — not wired to CLOB yet"
                            className="cursor-not-allowed rounded-md border border-zinc-700/50 px-2 py-1 text-[10px] font-semibold text-zinc-600"
                          >
                            TP
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
