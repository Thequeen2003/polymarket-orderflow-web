import type { TradeDirective } from './tradeDirective';
import type { SwitchForecast } from './sectionalMomentum';
import type { TapeVelocity } from './tapeVelocity';

export type PositionDeskAlertKind = 'danger' | 'warn' | 'info';

export type PositionDeskAlert = {
  kind: PositionDeskAlertKind;
  text: string;
};

/** Single glance readout: should you exit the side you marked as held? */
export type PositionExitBand = 'exit_now' | 'trim' | 'watch' | 'hold';

export type PositionExitReadout = {
  band: PositionExitBand;
  headline: string;
  detail: string | null;
};

/**
 * One-line “exit vs hold” for the Signals desk when the user has picked **I hold · UP/DOWN**.
 * Priority: card EXIT → strip EXIT → FLIP → TRIM → switch away → opposite add → tape fade → STAND_DOWN → hold.
 */
export function computePositionExitReadout(input: {
  heldLane: 'up' | 'down';
  directive: TradeDirective | null;
  forecast: SwitchForecast | null;
  tape: Pick<TapeVelocity, 'reliable' | 'dominance' | 'netPressure' | 'summary'>;
  upLabel: string;
  downLabel: string;
}): PositionExitReadout {
  const { heldLane, directive, forecast, tape, upLabel, downLabel } = input;
  const myName = heldLane === 'up' ? upLabel : downLabel;

  const tapeAgainst =
    tape.reliable &&
    ((heldLane === 'up' && tape.dominance === 'sell' && tape.netPressure < -18) ||
      (heldLane === 'down' && tape.dominance === 'buy' && tape.netPressure > 18));

  if (directive?.lane === heldLane && directive.action === 'EXIT') {
    return {
      band: 'exit_now',
      headline: `EXIT now — trade card is exiting ${myName}.`,
      detail: directive.headline?.trim() || directive.reason?.trim() || null,
    };
  }

  if (forecast?.status === 'EXIT' && forecast.lane === heldLane) {
    return {
      band: 'exit_now',
      headline: `EXIT now — sectional strip is exiting ${myName}.`,
      detail: forecast.headline?.trim() || forecast.reason?.trim() || null,
    };
  }

  if (directive?.action === 'FLIP') {
    return {
      band: 'exit_now',
      headline: 'EXIT / rotate — trade card is FLIP (structure turning).',
      detail: 'Treat as a primary risk event: defend, cut, or follow the card’s new lane — not “wait it out”.',
    };
  }

  if (directive?.lane === heldLane && directive.action === 'TRIM') {
    return {
      band: 'trim',
      headline: `TRIM ${myName} — take profits; not a forced full exit yet.`,
      detail: directive.headline?.trim() || null,
    };
  }

  if (
    forecast?.status === 'SWITCH_INCOMING' &&
    forecast.incomingLane != null &&
    forecast.incomingLane !== heldLane
  ) {
    const other = forecast.incomingLane === 'up' ? upLabel : downLabel;
    const eta =
      forecast.etaSec != null && Number.isFinite(forecast.etaSec) ? ` ~${Math.round(forecast.etaSec)}s` : '';
    return {
      band: 'watch',
      headline: `Watch exit — momentum is forming on ${other}${eta}.`,
      detail: `${myName} is losing sponsorship on the strip — tighten risk or pay yourself before the flip completes.`,
    };
  }

  if (
    directive &&
    directive.lane != null &&
    directive.lane !== heldLane &&
    (directive.action === 'INITIATE' || directive.action === 'ADD')
  ) {
    const other = directive.lane === 'up' ? upLabel : downLabel;
    return {
      band: 'watch',
      headline: `Watch exit — card is ${directive.action} on ${other}, not ${myName}.`,
      detail: 'Your token is not the live buy side; cut or wait for a clean re-sync.',
    };
  }

  if (tapeAgainst) {
    return {
      band: 'watch',
      headline: `Watch exit — desk tape is fading ${myName}.`,
      detail: tape.summary ? `Prints: ${tape.summary}` : 'Use prints as exit liquidity, not a reason to average down.',
    };
  }

  if (directive?.action === 'EXIT' && directive.lane != null && directive.lane !== heldLane) {
    const other = directive.lane === 'up' ? upLabel : downLabel;
    return {
      band: 'hold',
      headline: `Hold — exit is on ${other}, not ${myName}.`,
      detail: 'The card is exiting the other outcome token; your side is not the active exit line.',
    };
  }

  if (directive?.action === 'STAND_DOWN') {
    return {
      band: 'watch',
      headline: 'No add from model — stand down.',
      detail: `You can still hold ${myName}; reduce size if the tape feels worse than the card pause.`,
    };
  }

  return {
    band: 'hold',
    headline: `Hold — no EXIT on ${myName} right now.`,
    detail: 'Trade card is not calling EXIT / TRIM on your token. Keep TP/SL; the strip above still governs if that changes.',
  };
}

/**
 * High-salience alerts for the Signals desk after the operator picks **Entered · UP/DOWN**.
 * Pure helper — EXIT / TRIM / FLIP / sectional switch / tape fade vs held shares.
 */
export function buildPositionDeskAlerts(input: {
  heldLane: 'up' | 'down';
  directive: TradeDirective | null;
  forecast: SwitchForecast | null;
  tape: Pick<TapeVelocity, 'reliable' | 'dominance' | 'netPressure' | 'summary'>;
  upLabel: string;
  downLabel: string;
}): PositionDeskAlert[] {
  const { heldLane, directive, forecast, tape, upLabel, downLabel } = input;
  const myName = heldLane === 'up' ? upLabel : downLabel;
  const alerts: PositionDeskAlert[] = [];

  const tapeAgainst =
    tape.reliable &&
    ((heldLane === 'up' && tape.dominance === 'sell' && tape.netPressure < -18) ||
      (heldLane === 'down' && tape.dominance === 'buy' && tape.netPressure > 18));

  if (forecast?.status === 'EXIT' && forecast.lane === heldLane) {
    alerts.push({
      kind: 'danger',
      text: `Sectional EXIT on ${myName} — momentum is projecting a clean exit window; close or cut before prints gap.`,
    });
  }

  if (directive?.lane === heldLane && directive.action === 'EXIT') {
    alerts.push({
      kind: 'danger',
      text: `Trade card: EXIT ${myName} — treat this as your primary exit signal; do not add into the fade.`,
    });
  } else if (directive?.lane === heldLane && directive.action === 'TRIM') {
    alerts.push({
      kind: 'warn',
      text: `Trade card: TRIM ${myName} — bank partials at the bid; leave a runner only with a hard worst case.`,
    });
  } else if (directive?.action === 'FLIP') {
    alerts.push({
      kind: 'danger',
      text: 'Trade card: FLIP — thesis rotation. Defend or flatten; do not “hope through” a structural turn.',
    });
  }

  if (
    forecast?.status === 'SWITCH_INCOMING' &&
    forecast.incomingLane != null &&
    forecast.incomingLane !== heldLane
  ) {
    const other = forecast.incomingLane === 'up' ? upLabel : downLabel;
    const eta =
      forecast.etaSec != null && Number.isFinite(forecast.etaSec) ? ` (~${Math.round(forecast.etaSec)}s)` : '';
    alerts.push({
      kind: 'warn',
      text: `Incoming momentum toward ${other}${eta}. ${myName} is losing sponsorship on the strip — tighten risk or pay yourself.`,
    });
  }

  if (
    directive &&
    directive.lane != null &&
    directive.lane !== heldLane &&
    (directive.action === 'INITIATE' || directive.action === 'ADD')
  ) {
    const other = directive.lane === 'up' ? upLabel : downLabel;
    alerts.push({
      kind: 'warn',
      text: `Card is fresh ${directive.action} on ${other} while you hold ${myName} — your token is not the live buy; cut or wait for re-sync.`,
    });
  }

  if (tapeAgainst) {
    alerts.push({
      kind: 'warn',
      text: `Desk tape is fading ${myName} (${tape.summary}) — use prints as exit liquidity, not a reason to average down.`,
    });
  }

  const seen = new Set<string>();
  const out: PositionDeskAlert[] = [];
  for (const a of alerts) {
    if (seen.has(a.text)) continue;
    seen.add(a.text);
    out.push(a);
    if (out.length >= 4) break;
  }
  const rank: Record<PositionDeskAlertKind, number> = { danger: 0, warn: 1, info: 2 };
  out.sort((x, y) => rank[x.kind] - rank[y.kind]);
  return out;
}