/** Pure helpers for SL/TP transparency copy — mirrors logic in SignalsTradePanel effects (no side effects). */

export type BracketLegExplain = {
  label: 'SL' | 'TP';
  modeLine: string;
  watchLines: string[];
  distances: string[];
  blockers: string[];
  ruleLine: string;
};

function parseTriggerCents(s: string): number | null {
  const n = Number(String(s).trim());
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return null;
  return Math.round(n * 10) / 10;
}

function fmtCentsFrom01(x: number | null): string | null {
  if (x == null || !(x > 0) || !(x < 1)) return null;
  return `${(x * 100).toFixed(1)}¢`;
}

function buildSlExplain(args: {
  enabled: boolean;
  dual: boolean;
  stopCentsStr: string;
  limitCentsStr: string;
  sharesStr: string;
  bidTouch01: number | null;
  askTouch01: number | null;
  mark01: number | null;
  /** Same as bracket chart mid line: last trade / book mid fallback (`displayMark01 ?? mid`). */
  slStripMid01: number | null;
  slBid01: number | null;
  slAsk01: number | null;
  positionShares: number | null | undefined;
}): BracketLegExplain | null {
  if (!args.enabled) return null;
  const stopC = parseTriggerCents(args.stopCentsStr);
  const limitC = parseTriggerCents(args.limitCentsStr);
  const sh = Number(args.sharesStr);
  const blockers: string[] = [];
  if (stopC == null) blockers.push('Set a valid stop trigger between 1¢ and 99¢.');
  if (limitC == null) blockers.push('Set a valid limit price for the exit order.');
  if (!Number.isFinite(sh) || sh <= 0) blockers.push('Set bracket size (shares) greater than zero.');
  if (args.positionShares == null || !(args.positionShares > 0)) {
    blockers.push('No position on this outcome yet — levels save, but nothing sells until you are long.');
  }

  const stripMid = args.slStripMid01 ?? args.mark01;

  const modeLine = args.dual
    ? 'Fast mode: CLOB best bid polled ≈400ms (sell-side only — ask is shown for context, not used to trigger).'
    : 'Simple mode: best bid from the live book touch (same bid you would hit when selling).';

  const watchLines: string[] = [];
  if (args.dual) {
    const bc = fmtCentsFrom01(args.slBid01);
    const ac = fmtCentsFrom01(args.slAsk01);
    watchLines.push(`Poll bid ${bc ?? '—'} · poll ask ${ac ?? '—'} (ask not used for trigger)`);
  } else {
    const bc = fmtCentsFrom01(args.bidTouch01);
    watchLines.push(`Book bid ${bc ?? '—'}`);
  }
  const sc = fmtCentsFrom01(stripMid);
  if (sc) watchLines.push(`Chart mid ${sc} (also triggers SL when bid has not crossed yet)`);

  const distances: string[] = [];
  if (stopC != null) {
    if (args.dual) {
      const bid = args.slBid01;
      const ask = args.slAsk01;
      if (bid != null) {
        const d = (bid * 100 - stopC).toFixed(1);
        distances.push(`Bid ${(bid * 100).toFixed(1)}¢ is ${d}¢ above stop ${stopC.toFixed(1)}¢ (fires when bid is at or below stop).`);
      }
      if (ask != null) {
        const d = (ask * 100 - stopC).toFixed(1);
        distances.push(`Ask ${(ask * 100).toFixed(1)}¢ is ${d}¢ above stop ${stopC.toFixed(1)}¢.`);
      }
    } else {
      const ref = args.bidTouch01;
      const rc = fmtCentsFrom01(ref);
      if (ref != null && rc) {
        const d = (ref * 100 - stopC).toFixed(1);
        if (ref * 100 > stopC) {
          distances.push(`Bid ${rc} is ${d}¢ above stop ${stopC.toFixed(1)}¢.`);
        } else {
          distances.push(`Bid ${rc} is at/below stop — should fire immediately while armed.`);
        }
      } else {
        distances.push('Waiting for book bid to compute distance to stop.');
      }
    }
  }

  const ruleLine =
    'Fires when best bid ≤ stop, or chart mid ≤ stop if bid has not crossed yet (polled ≈400ms). Live exit is FAK at min(stop, bid), then market fallback.';

  return {
    label: 'SL',
    modeLine,
    watchLines,
    distances,
    blockers,
    ruleLine,
  };
}

function buildTpExplain(args: {
  enabled: boolean;
  dual: boolean;
  takeCentsStr: string;
  limitCentsStr: string;
  sharesStr: string;
  bidTouch01: number | null;
  askTouch01: number | null;
  mark01: number | null;
  /** Same as bracket chart mid line: last trade / book mid fallback (`displayMark01 ?? mid`). */
  tpStripMid01: number | null;
  tpBid01: number | null;
  tpAsk01: number | null;
  positionShares: number | null | undefined;
}): BracketLegExplain | null {
  if (!args.enabled) return null;
  const takeC = parseTriggerCents(args.takeCentsStr);
  const limitC = parseTriggerCents(args.limitCentsStr);
  const sh = Number(args.sharesStr);
  const blockers: string[] = [];
  if (takeC == null) blockers.push('Set a valid take trigger between 1¢ and 99¢.');
  if (limitC == null) blockers.push('Set a valid limit price for the exit order.');
  if (!Number.isFinite(sh) || sh <= 0) blockers.push('Set bracket size (shares) greater than zero.');
  if (args.positionShares == null || !(args.positionShares > 0)) {
    blockers.push('No position on this outcome yet — levels save, but nothing sells until you are long.');
  }

  const stripMid = args.tpStripMid01 ?? args.mark01;

  const modeLine = args.dual
    ? 'Dual watch: polled bid/ask ≈400ms while armed (ask is display-only).'
    : 'While armed, CLOB best bid is polled ≈400ms; book touch is fallback.';

  const watchLines: string[] = [];
  if (args.dual) {
    const bc = fmtCentsFrom01(args.tpBid01);
    const ac = fmtCentsFrom01(args.tpAsk01);
    watchLines.push(`Poll bid ${bc ?? '—'} · poll ask ${ac ?? '—'} (ask not used for trigger)`);
  } else {
    const bc = fmtCentsFrom01(args.bidTouch01);
    watchLines.push(`Book bid ${bc ?? '—'}`);
  }
  const sc = fmtCentsFrom01(stripMid);
  if (sc) watchLines.push(`Chart mid ${sc} (triggers TP when bid is still below take)`);

  const distances: string[] = [];
  if (takeC != null) {
    if (args.dual) {
      const bid = args.tpBid01;
      const ask = args.tpAsk01;
      if (bid != null) {
        const d = (takeC - bid * 100).toFixed(1);
        distances.push(`Bid ${(bid * 100).toFixed(1)}¢ is ${d}¢ below take ${takeC.toFixed(1)}¢ (fires when bid is at or above take).`);
      }
      if (ask != null) {
        const d = (takeC - ask * 100).toFixed(1);
        distances.push(`Ask ${(ask * 100).toFixed(1)}¢ is ${d}¢ below take ${takeC.toFixed(1)}¢.`);
      }
    } else {
      const ref = args.bidTouch01;
      const rc = fmtCentsFrom01(ref);
      if (ref != null && rc) {
        const d = (takeC - ref * 100).toFixed(1);
        if (ref * 100 < takeC) {
          distances.push(`Bid ${rc} is ${d}¢ below take ${takeC.toFixed(1)}¢.`);
        } else {
          distances.push(`Bid ${rc} is at/above take — should fire immediately while armed.`);
        }
      } else {
        distances.push('Waiting for book bid to compute distance to take.');
      }
    }
  }

  const ruleLine =
    'Fires when best bid ≥ take, or chart mid ≥ take if bid has not crossed yet (polled ≈400ms). Live exit is FAK at min(take, bid), then market fallback if no match.';

  return {
    label: 'TP',
    modeLine,
    watchLines,
    distances,
    blockers,
    ruleLine,
  };
}

/** Optional one-liner appended to SL/TP rule lines (settlement / bell physics). */
export type BracketPhysicsSuffix = string | null | undefined;

function withPhysicsSuffix(ruleLine: string, suffix: BracketPhysicsSuffix): string {
  const s = suffix?.trim();
  if (!s) return ruleLine;
  return `${ruleLine} ${s}`;
}

export function buildBracketAutomationExplain(args: {
  stopLossEnabled: boolean;
  stopLossDualBook: boolean;
  stopLossStopCents: string;
  stopLossLimitCents: string;
  stopLossShares: string;
  takeProfitEnabled: boolean;
  takeProfitDualBook: boolean;
  takeProfitTakeCents: string;
  takeProfitLimitCents: string;
  takeProfitShares: string;
  bidTouch01: number | null;
  askTouch01: number | null;
  mark01: number | null;
  tpStripMid01: number | null;
  slStripMid01: number | null;
  slStopWatchBid01: number | null;
  slStopWatchAsk01: number | null;
  tpTakeWatchBid01: number | null;
  tpTakeWatchAsk01: number | null;
  positionShares: number | null | undefined;
  /** Settlement / bell context for both legs (same string on SL and TP). */
  physicsSuffix?: BracketPhysicsSuffix;
}): { sl: BracketLegExplain | null; tp: BracketLegExplain | null } {
  const suffix = args.physicsSuffix;
  const sl = buildSlExplain({
    enabled: args.stopLossEnabled,
    dual: args.stopLossDualBook,
    stopCentsStr: args.stopLossStopCents,
    limitCentsStr: args.stopLossLimitCents,
    sharesStr: args.stopLossShares,
    bidTouch01: args.bidTouch01,
    askTouch01: args.askTouch01,
    mark01: args.mark01,
    slStripMid01: args.slStripMid01,
    slBid01: args.slStopWatchBid01,
    slAsk01: args.slStopWatchAsk01,
    positionShares: args.positionShares,
  });
  if (sl) sl.ruleLine = withPhysicsSuffix(sl.ruleLine, suffix);

  const tp = buildTpExplain({
    enabled: args.takeProfitEnabled,
    dual: args.takeProfitDualBook,
    takeCentsStr: args.takeProfitTakeCents,
    limitCentsStr: args.takeProfitLimitCents,
    sharesStr: args.takeProfitShares,
    bidTouch01: args.bidTouch01,
    askTouch01: args.askTouch01,
    mark01: args.mark01,
    tpStripMid01: args.tpStripMid01,
    tpBid01: args.tpTakeWatchBid01,
    tpAsk01: args.tpTakeWatchAsk01,
    positionShares: args.positionShares,
  });
  if (tp) tp.ruleLine = withPhysicsSuffix(tp.ruleLine, suffix);

  return { sl, tp };
}
