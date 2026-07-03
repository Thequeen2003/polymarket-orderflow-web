import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { UpdownInterval } from './lib/api';
import {
  ONE_SIGNAL_ASSETS,
  ONE_SIGNAL_TRADE_USD,
  formatOneSignalSessionSummary,
} from './oneSignalSessionAutoTrade';
import {
  loadOneSignalSessionConfig,
  loadOneSignalSessionState,
  saveOneSignalSessionEnabled,
  saveOneSignalSessionInterval,
  saveOneSignalSessionTpGainPct,
  saveOneSignalSessionWatchStopPct,
  sessionRemainingMs,
} from './oneSignalSessionPersist';
import { BPX_ONE_SIGNAL_SESSION_STATUS_EVENT } from './useOneSignalSessionAutoTrade';
import { useTradeAccountMode } from './useTradeAccountMode';

function pctToDisplay(p: number): string {
  return String(Math.round(p * 1000) / 10);
}

function parsePctInput(raw: string, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(20, n)) / 100;
}

export function OneSignalSessionPanel(props: {
  statusLine?: string | null;
}): ReactElement {
  const { statusLine: statusProp = null } = props;
  const tradeAccountMode = useTradeAccountMode();
  const liveMode = tradeAccountMode === 'live';
  const [statusLine, setStatusLine] = useState<string | null>(statusProp);
  const [enabled, setEnabled] = useState(() => loadOneSignalSessionConfig().enabled);
  const [interval, setInterval] = useState<UpdownInterval>(() => loadOneSignalSessionConfig().interval);
  const [tpPctStr, setTpPctStr] = useState(() => pctToDisplay(loadOneSignalSessionConfig().tpGainPct));
  const [watchStopPctStr, setWatchStopPctStr] = useState(() =>
    pctToDisplay(loadOneSignalSessionConfig().watchStopPct),
  );
  const [sessionState, setSessionState] = useState(() => loadOneSignalSessionState());
  const [remainingMs, setRemainingMs] = useState(() => sessionRemainingMs());

  useEffect(() => {
    const onStatus = (ev: Event) => {
      const line = (ev as CustomEvent<{ line?: string | null }>).detail?.line ?? null;
      setStatusLine(line);
    };
    window.addEventListener(BPX_ONE_SIGNAL_SESSION_STATUS_EVENT, onStatus as EventListener);
    return () => window.removeEventListener(BPX_ONE_SIGNAL_SESSION_STATUS_EVENT, onStatus as EventListener);
  }, []);

  useEffect(() => {
    setStatusLine(statusProp);
  }, [statusProp]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setSessionState(loadOneSignalSessionState());
      setRemainingMs(sessionRemainingMs());
    }, 5000);
    return () => window.clearInterval(id);
  }, []);

  const tradedAssets = useMemo(() => new Set(sessionState.trades.map((t) => t.asset)), [sessionState.trades]);
  const remainingMin = Math.ceil(remainingMs / 60_000);

  const onToggle = useCallback((on: boolean) => {
    setEnabled(on);
    saveOneSignalSessionEnabled(on);
  }, []);

  const onIntervalChange = useCallback((v: UpdownInterval) => {
    setInterval(v);
    saveOneSignalSessionInterval(v);
  }, []);

  const commitTpPct = useCallback(() => {
    const pct = parsePctInput(tpPctStr, loadOneSignalSessionConfig().tpGainPct);
    setTpPctStr(pctToDisplay(pct));
    saveOneSignalSessionTpGainPct(pct);
  }, [tpPctStr]);

  const commitWatchStop = useCallback(() => {
    const pct = parsePctInput(watchStopPctStr, loadOneSignalSessionConfig().watchStopPct);
    setWatchStopPctStr(pctToDisplay(pct));
    saveOneSignalSessionWatchStopPct(pct);
  }, [watchStopPctStr]);

  return (
    <div className="space-y-2 rounded-lg border border-violet-900/45 bg-violet-950/15 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wide text-violet-200/90">
          One-signal · 4 crypto session
        </span>
        <span className="text-[9px] text-zinc-500">{remainingMin}m left in 25m window</span>
      </div>
      <p className="text-[10px] leading-snug text-zinc-500">
        One perfect <span className="font-semibold text-zinc-300">${ONE_SIGNAL_TRADE_USD}</span> buy per crypto per
        25-minute session — mean-implied TP sell-up, watch stop via % below (no SL order on entry).
      </p>
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 shrink-0 accent-violet-500"
          checked={enabled}
          disabled={!liveMode}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span className="text-[10px] leading-snug text-zinc-300">
          <span className="font-bold text-violet-200/95">Auto-trade all 4 cryptos</span>
          {!liveMode ? (
            <span className="text-amber-200/90"> — switch Trade panel to Live first.</span>
          ) : (
            <span className="text-zinc-500"> — BTC · ETH · SOL · HYPE once each per session.</span>
          )}
        </span>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[10px] text-zinc-400">
          <span className="mb-1 block font-semibold uppercase tracking-wide">Market interval</span>
          <select
            value={interval}
            onChange={(e) => onIntervalChange(e.target.value as UpdownInterval)}
            className="w-full rounded-lg border border-zinc-700/60 bg-zinc-950/60 px-2 py-1.5 font-mono text-xs text-zinc-100"
          >
            <option value="15m">15m (default)</option>
            <option value="5m">5m</option>
          </select>
        </label>
        <div className="text-[10px] text-zinc-500">
          <span className="mb-1 block font-semibold uppercase tracking-wide text-zinc-400">Session progress</span>
          <ul className="space-y-0.5 font-mono tabular-nums">
            {ONE_SIGNAL_ASSETS.map((a) => (
              <li key={a} className={tradedAssets.has(a) ? 'text-emerald-300/90' : 'text-zinc-500'}>
                {a.toUpperCase()} {tradedAssets.has(a) ? '✓ traded' : '— waiting'}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[10px] text-zinc-400">
          <span className="mb-1 block font-semibold uppercase tracking-wide text-emerald-200/80">TP gain % (mean)</span>
          <div className="flex gap-1">
            <input
              type="number"
              min={1}
              max={20}
              step={0.5}
              value={tpPctStr}
              onChange={(e) => setTpPctStr(e.target.value)}
              onBlur={commitTpPct}
              className="w-full rounded-lg border border-zinc-700/60 bg-zinc-950/60 px-2 py-1.5 text-right font-mono text-xs text-emerald-50"
            />
            <span className="self-center text-zinc-500">%</span>
          </div>
          <span className="mt-0.5 block text-[9px] text-zinc-600">Floor for computed mean take-profit.</span>
        </label>
        <label className="block text-[10px] text-zinc-400">
          <span className="mb-1 block font-semibold uppercase tracking-wide text-rose-200/80">Watch stop %</span>
          <div className="flex gap-1">
            <input
              type="number"
              min={1}
              max={20}
              step={0.5}
              value={watchStopPctStr}
              onChange={(e) => setWatchStopPctStr(e.target.value)}
              onBlur={commitWatchStop}
              className="w-full rounded-lg border border-zinc-700/60 bg-zinc-950/60 px-2 py-1.5 text-right font-mono text-xs text-rose-50"
            />
            <span className="self-center text-zinc-500">%</span>
          </div>
          <span className="mt-0.5 block text-[9px] text-zinc-600">Monitor-only bracket — not armed on buy.</span>
        </label>
      </div>
      {sessionState.trades.length > 0 ? (
        <p className="text-[10px] leading-snug text-violet-200/70">{formatOneSignalSessionSummary(sessionState.trades)}</p>
      ) : null}
      {statusLine?.trim() ? (
        <p className="text-[10px] leading-snug text-amber-200/90">{statusLine.trim()}</p>
      ) : enabled && liveMode ? (
        <p className="text-[10px] leading-snug text-violet-200/60">Scanning snapshots — fires on clear spot vs PTB signal.</p>
      ) : null}
    </div>
  );
}
