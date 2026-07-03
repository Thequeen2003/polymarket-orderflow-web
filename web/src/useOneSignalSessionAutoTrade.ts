import { useCallback, useEffect, useRef, useState } from 'react';
import {
  agentSnapshot,
  marketsUpdownShortcut,
  type ApiOk,
  type UpdownShortcutAsset,
} from './lib/api';
import {
  ONE_SIGNAL_ASSETS,
  ONE_SIGNAL_TRADE_USD,
  buildOneSignalTakePlan,
  evaluateOneSignalSnapshot,
  type AgentSnapshotPayload,
  type OneSignalTradeRequest,
} from './oneSignalSessionAutoTrade';
import {
  hasTradedAssetThisSession,
  loadOneSignalSessionConfig,
  markOneSignalAssetInFlight,
} from './oneSignalSessionPersist';
import type { TradeAccountMode } from './tradeAccountMode';

const POLL_MS = 22_000;
const COOLDOWN_MS = 50_000;

function isOk<T>(x: unknown): x is ApiOk<T> {
  return typeof x === 'object' && x != null && (x as ApiOk<T>).ok === true && 'data' in (x as object);
}

export const BPX_ONE_SIGNAL_SESSION_TRADE_EVENT = 'bpx-one-signal-session-trade';
export const BPX_ONE_SIGNAL_SESSION_STATUS_EVENT = 'bpx-one-signal-session-status';

function emitOneSignalStatus(line: string | null): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(BPX_ONE_SIGNAL_SESSION_STATUS_EVENT, { detail: { line } }));
}

export function useOneSignalSessionAutoTrade(opts: {
  tradeAccountMode: TradeAccountMode;
  /** True when trade panel can submit (books loaded for current slug). */
  tradingReady: boolean;
}): { statusLine: string | null; scanning: boolean } {
  const { tradeAccountMode, tradingReady } = opts;
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const lastFireRef = useRef<Record<string, number>>({});
  const busyRef = useRef(false);

  const dispatchTrade = useCallback((req: OneSignalTradeRequest) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(BPX_ONE_SIGNAL_SESSION_TRADE_EVENT, { detail: req }));
  }, []);

  const scanAsset = useCallback(
    async (asset: UpdownShortcutAsset, cfg: ReturnType<typeof loadOneSignalSessionConfig>) => {
      if (hasTradedAssetThisSession(asset)) return;

      const cooldownKey = `${asset}|${cfg.interval}`;
      const last = lastFireRef.current[cooldownKey] ?? 0;
      if (Date.now() - last < COOLDOWN_MS) return;

      const shortcut = await marketsUpdownShortcut(asset, cfg.interval);
      if (!isOk(shortcut)) {
        const msg = `${asset.toUpperCase()} shortcut failed — retrying.`;
        setStatusLine(msg);
        emitOneSignalStatus(msg);
        return;
      }
      const slug = (shortcut.data.trading_slug ?? shortcut.data.slug)?.trim();
      if (!slug) return;

      const snapRes = await agentSnapshot(asset, cfg.interval);
      if (!isOk(snapRes)) {
        const msg = `${asset.toUpperCase()} snapshot failed.`;
        setStatusLine(msg);
        emitOneSignalStatus(msg);
        return;
      }
      const snap = snapRes.data as AgentSnapshotPayload;
      const evalResult = evaluateOneSignalSnapshot(snap, cfg.watchStopPct, cfg.tpGainPct);
      if (!evalResult.ok) return;

      const plan = buildOneSignalTakePlan(evalResult, asset);
      if (!plan.canTake || !evalResult.lane || evalResult.entry01 == null || evalResult.takeProfit01 == null || evalResult.watchStop01 == null) {
        return;
      }

      if (!markOneSignalAssetInFlight(asset)) return;

      lastFireRef.current[cooldownKey] = Date.now();

      const remainingMs = snap.window?.remainingMs ?? null;
      dispatchTrade({
        asset,
        slug,
        plan,
        takeProfit01: evalResult.takeProfit01,
        watchStop01: evalResult.watchStop01,
        sizeUsd: ONE_SIGNAL_TRADE_USD,
        endsInMs: remainingMs,
        market: shortcut.data.market,
      });

      const msg = `Queued ${asset.toUpperCase()} ${evalResult.lane.toUpperCase()} @ ${Math.round(evalResult.entry01 * 100)}¢ · TP ${Math.round(evalResult.takeProfit01 * 100)}¢`;
      setStatusLine(msg);
      emitOneSignalStatus(msg);
    },
    [dispatchTrade],
  );

  useEffect(() => {
    const cfg = loadOneSignalSessionConfig();
    if (!cfg.enabled || tradeAccountMode !== 'live') {
      setScanning(false);
      return;
    }

    let cancelled = false;

    const tick = async () => {
      if (cancelled || busyRef.current) return;
      busyRef.current = true;
      setScanning(true);
      try {
        const liveCfg = loadOneSignalSessionConfig();
        if (!liveCfg.enabled) return;
        for (const asset of ONE_SIGNAL_ASSETS) {
          if (cancelled) break;
          await scanAsset(asset, liveCfg);
        }
      } finally {
        busyRef.current = false;
        if (!cancelled) setScanning(false);
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [scanAsset, tradeAccountMode, tradingReady]);

  return { statusLine, scanning };
}
