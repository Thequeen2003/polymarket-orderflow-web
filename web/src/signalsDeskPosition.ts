/**
 * Outcome position truth for Signals desk “I hold” — ack after real shares, clear when flat.
 */

import { useEffect, useRef } from 'react';
import type { ApiErr, ApiOk } from './lib/api';
import { tradeBalanceAllowance } from './lib/api';
import { getPaperPosition, loadPaperAccount, PAPER_ORDERS_SYNC_EVENT } from './paperTrading';
import { PAPER_ACCOUNT_SYNC_EVENT } from './paperAccountSync';
import { TRADE_HISTORY_CHANGED_EVENT } from './tradeHistory';
import { dispatchSignalsClearHold, isOutcomePositionFlat } from './signalsDeskHold';

function isOk<T>(res: ApiOk<T> | ApiErr): res is ApiOk<T> {
  return res.ok === true;
}

export const BPX_OUTCOME_POSITIONS_EVENT = 'bpx-outcome-positions';

export type OutcomePositionsDetail = {
  /** Market slug from the trade panel that emitted this snapshot (ignore stale events after slug switch). */
  slug?: string;
  mode: 'paper' | 'live';
  up: { tokenId: string; shares: number | null };
  down: { tokenId: string; shares: number | null };
};

export function outcomePositionsDetailMatchesTokens(
  detail: OutcomePositionsDetail,
  upToken: string,
  downToken: string,
): boolean {
  const up = upToken.trim();
  const down = downToken.trim();
  if (!up || !down) return false;
  return detail.up.tokenId.trim() === up && detail.down.tokenId.trim() === down;
}

export function dispatchOutcomePositions(detail: OutcomePositionsDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(BPX_OUTCOME_POSITIONS_EVENT, { detail }));
}

function parseBalanceShares(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function readPaperOutcomeShares(tokenId: string): number {
  const t = tokenId.trim();
  if (!t) return 0;
  return getPaperPosition(loadPaperAccount(), t).shares;
}

export async function readLiveOutcomeShares(tokenId: string): Promise<number | null> {
  const t = tokenId.trim();
  if (!t) return null;
  try {
    const res = await tradeBalanceAllowance({ tokenId: t, assetType: 'conditional' });
    if (!isOk(res)) return null;
    return parseBalanceShares(res.data.balance);
  } catch {
    return null;
  }
}

/** Prefer paper when it shows size; otherwise live balance. */
export async function readBestOutcomeShares(
  tokenId: string,
  mode?: 'paper' | 'live',
): Promise<number> {
  const t = tokenId.trim();
  if (!t) return 0;
  if (mode === 'live') {
    const live = await readLiveOutcomeShares(t);
    return live != null && Number.isFinite(live) ? live : 0;
  }
  if (mode === 'paper') return readPaperOutcomeShares(t);
  const paper = readPaperOutcomeShares(t);
  if (!isOutcomePositionFlat(paper)) return paper;
  const live = await readLiveOutcomeShares(t);
  if (live != null && Number.isFinite(live)) return live;
  return paper;
}

export function sharesForLane(detail: OutcomePositionsDetail, lane: 'up' | 'down'): number | null {
  return lane === 'up' ? detail.up.shares : detail.down.shares;
}

/**
 * Keep “I hold · UP/DOWN” in sync with wallet:
 * - auto-activate when take-signal / auto-trade fill shows shares on that outcome
 * - auto-deactivate when that outcome goes flat after you held size
 */
export function useSignalsDeskHoldPositionSync(args: {
  slug: string;
  manualLane: 'up' | 'down' | null;
  pendingHoldLane: 'up' | 'down' | null;
  upToken: string;
  downToken: string;
  onAckLane: (lane: 'up' | 'down' | null) => void;
  onPendingHoldConsumed: () => void;
}): void {
  const { slug, manualLane, pendingHoldLane, upToken, downToken, onAckLane, onPendingHoldConsumed } = args;
  const slugKey = slug.trim();

  const manualLaneRef = useRef(manualLane);
  const pendingRef = useRef(pendingHoldLane);
  const onAckRef = useRef(onAckLane);
  const onPendingConsumedRef = useRef(onPendingHoldConsumed);
  const lastPositionsRef = useRef<OutcomePositionsDetail | null>(null);
  const laneHadSharesRef = useRef({ up: false, down: false });

  manualLaneRef.current = manualLane;
  pendingRef.current = pendingHoldLane;
  onAckRef.current = onAckLane;
  onPendingConsumedRef.current = onPendingHoldConsumed;

  useEffect(() => {
    lastPositionsRef.current = null;
    laneHadSharesRef.current = { up: false, down: false };
  }, [upToken, downToken]);

  useEffect(() => {
    const resolveShares = async (lane: 'up' | 'down'): Promise<number> => {
      const token = lane === 'up' ? upToken.trim() : downToken.trim();
      if (!token) return 0;
      const detail = lastPositionsRef.current;
      if (detail) {
        const leg = lane === 'up' ? detail.up : detail.down;
        if (leg.tokenId.trim() === token && leg.shares != null && Number.isFinite(leg.shares)) {
          return leg.shares;
        }
      }
      return readBestOutcomeShares(token, detail?.mode);
    };

    const syncLane = async (lane: 'up' | 'down', shares?: number | null) => {
      const sh = shares != null && Number.isFinite(shares) ? shares : await resolveShares(lane);
      const flat = isOutcomePositionFlat(sh);
      const pending = pendingRef.current;
      const held = manualLaneRef.current;

      if (!flat) laneHadSharesRef.current[lane] = true;

      if (pending === lane && !flat) {
        // Operator already tagged the other side — do not overwrite with pending/auto fill.
        if (held != null && held !== lane) {
          onPendingConsumedRef.current();
          return;
        }
        if (held !== lane) onAckRef.current(lane);
        laneHadSharesRef.current[lane] = true;
        onPendingConsumedRef.current();
        return;
      }

      if (held === lane && flat && laneHadSharesRef.current[lane]) {
        onAckRef.current(null);
        laneHadSharesRef.current[lane] = false;
        dispatchSignalsClearHold({ lane });
      }
    };

    const pollAll = () => {
      const detail = lastPositionsRef.current;
      if (detail && outcomePositionsDetailMatchesTokens(detail, upToken, downToken)) {
        void syncLane('up', sharesForLane(detail, 'up'));
        void syncLane('down', sharesForLane(detail, 'down'));
        return;
      }
      void syncLane('up');
      void syncLane('down');
    };

    const onPos = (ev: Event) => {
      const detail = (ev as CustomEvent<OutcomePositionsDetail>).detail;
      if (!detail) return;
      if (detail.slug?.trim() && slugKey && detail.slug.trim() !== slugKey) return;
      if (!outcomePositionsDetailMatchesTokens(detail, upToken, downToken)) return;
      lastPositionsRef.current = detail;
      pollAll();
    };

    const bump = () => pollAll();

    if (manualLane != null || pendingHoldLane != null) pollAll();

    const ms = pendingHoldLane != null ? 700 : 1_500;
    const id = window.setInterval(() => {
      if (manualLaneRef.current == null && pendingRef.current == null) return;
      pollAll();
    }, ms);

    window.addEventListener(BPX_OUTCOME_POSITIONS_EVENT, onPos);
    window.addEventListener(PAPER_ACCOUNT_SYNC_EVENT, bump);
    window.addEventListener(PAPER_ORDERS_SYNC_EVENT, bump);
    window.addEventListener(TRADE_HISTORY_CHANGED_EVENT, bump);

    return () => {
      window.clearInterval(id);
      window.removeEventListener(BPX_OUTCOME_POSITIONS_EVENT, onPos);
      window.removeEventListener(PAPER_ACCOUNT_SYNC_EVENT, bump);
      window.removeEventListener(PAPER_ORDERS_SYNC_EVENT, bump);
      window.removeEventListener(TRADE_HISTORY_CHANGED_EVENT, bump);
    };
  }, [slugKey, manualLane, pendingHoldLane, upToken, downToken]);
}
