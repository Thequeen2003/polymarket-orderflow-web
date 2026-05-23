/**
 * Live order truth: patch local history from my-fills immediately, then CLOB fill index.
 */

import type { MyFillRow } from './lib/api';
import { reconcileTradeHistoryFromClob } from './reconcileTradeHistoryFromClob';
import { syncTradeHistoryFromMyFills } from './syncTradeHistoryFromMyFills';

export type LiveTokenTruthResult = {
  myFillsSync: number;
  clobReconcile: number;
};

/** Sync local buy/sell row sizes to exchange tape (my-fills first, then CLOB VWAP index). */
export async function reconcileLiveTokenTruth(
  tokenId: string,
  opts?: { fills?: MyFillRow[]; force?: boolean },
): Promise<LiveTokenTruthResult> {
  const tid = tokenId.trim();
  if (!tid) return { myFillsSync: 0, clobReconcile: 0 };

  let myFillsSync = 0;
  if (opts?.fills?.length) {
    myFillsSync = syncTradeHistoryFromMyFills(opts.fills, tid);
  }

  let clobReconcile = 0;
  try {
    clobReconcile = await reconcileTradeHistoryFromClob(tid, {
      force: opts?.force === true || myFillsSync > 0,
    });
  } catch {
    /* ignore */
  }

  return { myFillsSync, clobReconcile };
}

export function liveTruthChanged(result: LiveTokenTruthResult): boolean {
  return result.myFillsSync > 0 || result.clobReconcile > 0;
}
