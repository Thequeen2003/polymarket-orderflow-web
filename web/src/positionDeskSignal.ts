/**
 * One fused desk signal — bracket TP/SL + momentum stall/flip.
 */

import type { DeskMomentumReadout } from './deskMomentumTracker';
import type { PositionBracketCall } from './positionBracketCall';

export type DeskSignalAction = 'sell_now' | 'take_profit' | 'watch' | 'hold' | 'ride';

export type PositionDeskSignal = {
  action: DeskSignalAction;
  severity: 'danger' | 'warn' | 'profit' | 'ok';
  badge: string;
  headline: string;
  detail: string;
  reason: string;
  exitPressure: number;
  midTrailCents: number[];
  entryCents: number | null;
  bidCents: number | null;
  deskTpNowCents: number | null;
  deskTpLeadDropCents: number | null;
  /** Estimated odds armed TP tags from here (0–100). */
  tpHitProbPct: number | null;
  momentumPhase: DeskMomentumReadout['phase'] | null;
};

function fmt(c: number): string {
  return `${c.toFixed(1)}¢`;
}

/** Merge bracket call + momentum into a single actionable line. */
export function buildPositionDeskSignal(input: {
  bracket: PositionBracketCall | null;
  momentum: DeskMomentumReadout | null;
  tpHitProb01?: number | null;
}): PositionDeskSignal | null {
  const { bracket, momentum, tpHitProb01 = null } = input;
  if (!bracket && !momentum) return null;

  const trail = momentum?.midTrailCents ?? [];
  const exitPressure = Math.max(momentum?.exitPressure ?? 0, bracketPressure(bracket));
  const entryCents = bracket?.entryCents ?? null;
  const bidCents = bracket?.bidCents ?? null;
  const deskTpNowCents = momentum?.deskTpNowCents ?? bracket?.liveDeskTpCents ?? null;
  const deskTpLeadDropCents = momentum?.deskTpLeadDropCents ?? null;
  const tpHitProbPct =
    tpHitProb01 != null && Number.isFinite(tpHitProb01) ? Math.round(tpHitProb01 * 100) : null;
  const momentumPhase = momentum?.phase ?? null;

  const base = {
    midTrailCents: trail,
    entryCents,
    bidCents,
    deskTpNowCents,
    deskTpLeadDropCents,
    tpHitProbPct,
    momentumPhase,
  };

  if (bracket?.action === 'take_profit') {
    return {
      action: 'take_profit',
      severity: 'profit',
      badge: 'Take profit',
      headline: bracket.headline,
      detail: momentum?.phase === 'climbing' ? `${bracket.detail} Momentum still OK — but TP tagged, sell.` : bracket.detail,
      reason: 'tp_hit',
      exitPressure: Math.max(exitPressure, 95),
      ...base,
    };
  }

  if (bracket?.action === 'sell_now') {
    return {
      action: 'sell_now',
      severity: 'danger',
      badge: 'Sell now',
      headline: bracket.headline,
      detail: momentum ? `${bracket.detail} ${momentum.detail}` : bracket.detail,
      reason: bracket.reason,
      exitPressure: Math.max(exitPressure, 92),
      ...base,
    };
  }

  if (momentum?.phase === 'switched' || momentum?.phase === 'reversing') {
    return {
      action: 'sell_now',
      severity: 'danger',
      badge: 'Sell now',
      headline: momentum.headline,
      detail: bracket
        ? `${momentum.detail} Bracket: entry ${fmt(entryCents ?? 0)} · bid ${bidCents != null ? fmt(bidCents) : '—'}.`
        : momentum.detail,
      reason: momentum.phase === 'switched' ? 'momentum_switched' : 'momentum_reversing',
      exitPressure,
      ...base,
    };
  }

  if (momentum?.phase === 'fading') {
    const urgent =
      (deskTpLeadDropCents ?? 0) >= 0.5 ||
      momentum.severity === 'danger' ||
      (tpHitProbPct != null && tpHitProbPct < 35);
    return {
      action: urgent ? 'sell_now' : 'watch',
      severity: urgent ? 'danger' : 'warn',
      badge: urgent ? 'Sell now' : 'Momentum fade',
      headline: momentum.headline,
      detail:
        tpHitProbPct != null
          ? `${momentum.detail} TP hit odds now ~${tpHitProbPct}% — ${urgent ? 'exit on bid.' : 'tighten or clip.'}`
          : momentum.detail,
      reason: 'momentum_fading',
      exitPressure: Math.max(exitPressure, urgent ? 78 : 62),
      ...base,
    };
  }

  if (momentum?.phase === 'stagnating' && (deskTpLeadDropCents ?? 0) >= 1.2) {
    return {
      action: 'sell_now',
      severity: 'danger',
      badge: 'Sell now',
      headline: momentum.headline,
      detail: `Desk TP lead drop −${deskTpLeadDropCents!.toFixed(1)}¢ at the high — TP won't pay from here. ${bracket?.detail ?? 'Take the bid.'}`,
      reason: 'desk_tp_stall',
      exitPressure,
      ...base,
    };
  }

  if (bracket?.action === 'watch_sl') {
    return {
      action: 'watch',
      severity: 'warn',
      badge: 'Watch stop',
      headline: bracket.headline,
      detail: momentum?.phase === 'stagnating' ? `${bracket.detail} ${momentum.headline}` : bracket.detail,
      reason: 'sl_near',
      exitPressure,
      ...base,
    };
  }

  if (momentum?.phase === 'stagnating') {
    return {
      action: 'watch',
      severity: 'warn',
      badge: 'Stalling',
      headline: momentum.headline,
      detail: momentum.detail,
      reason: 'momentum_stall',
      exitPressure,
      ...base,
    };
  }

  if (momentum?.phase === 'climbing') {
    return {
      action: 'ride',
      severity: 'ok',
      badge: 'Ride',
      headline: momentum.headline,
      detail: bracket ? `${momentum.detail} ${bracket.headline}` : momentum.detail,
      reason: 'momentum_climb',
      exitPressure,
      ...base,
    };
  }

  if (bracket) {
    return {
      action: bracket.action === 'hold' ? 'hold' : 'watch',
      severity: bracket.severity === 'ok' ? 'ok' : 'warn',
      badge: bracket.severity === 'ok' ? 'Hold' : 'Watch',
      headline: bracket.headline,
      detail: bracket.detail,
      reason: bracket.reason,
      exitPressure,
      ...base,
    };
  }

  return {
    action: 'hold',
    severity: momentum!.severity === 'danger' ? 'warn' : momentum!.severity === 'warn' ? 'warn' : 'ok',
    badge: 'Hold',
    headline: momentum!.headline,
    detail: momentum!.detail,
    reason: 'momentum_idle',
    exitPressure,
    ...base,
  };
}

function bracketPressure(bracket: PositionBracketCall | null): number {
  if (!bracket) return 0;
  if (bracket.action === 'sell_now') return 90;
  if (bracket.action === 'take_profit') return 95;
  if (bracket.action === 'watch_sl') return 55;
  return 10;
}
