import type { TradeDirective } from './tradeDirective';
import type { TradeLevels } from './tradeLevels';
import type { SwitchForecast } from './sectionalMomentum';
import type { TapeVelocity } from './tapeVelocity';

export type SignalTakenPlaybookInput = {
  myLane: 'up' | 'down';
  /** When the operator tapped acknowledgment (ms epoch). */
  takenAtMs: number | null;
  directive: TradeDirective | null;
  levels: TradeLevels | null;
  crossProb: number | null;
  endsInMs: number | null;
  forecast: SwitchForecast | null;
  tape: TapeVelocity;
  upLabel: string;
  downLabel: string;
};

export type SignalTakenPlaybook = {
  tone: 'constructive' | 'caution' | 'risk';
  headline: string;
  bullets: string[];
};

/**
 * After the user confirms they took the **trade entry signal** (picked a side), synthesize sizing / exit guidance
 * from the live directive, sectional switch read, tape, cross model, and clock.
 * Pure function — no React.
 */
export function computeSignalTakenPlaybook(input: SignalTakenPlaybookInput): SignalTakenPlaybook {
  const { myLane, directive, levels, crossProb, endsInMs, forecast, tape, upLabel, downLabel } = input;
  const myName = myLane === 'up' ? upLabel : downLabel;
  const bullets: string[] = [];
  let tone: SignalTakenPlaybook['tone'] = 'constructive';
  let headline = `Managing ${myName}`;
  /** Card + your ack agree you should stay on this outcome (HOLD/ADD, or INITIATE on same side = treat as hold). */
  let cardBacksHoldThesis = false;

  const noDirective = directive == null;

  const tapeAgainst =
    tape.reliable &&
    ((myLane === 'up' && tape.dominance === 'sell' && tape.netPressure < -18) ||
      (myLane === 'down' && tape.dominance === 'buy' && tape.netPressure > 18));
  if (noDirective) {
    bullets.push(
      `You confirmed ${myName} — hold ${myName} until the live trade card refreshes.`,
    );
  }

  if (tapeAgainst) {
    bullets.push(
      `Desk tape leans against ${myName} (${tape.summary}). Prefer banking partials on favorable prints over adding into the fade.`,
    );
    tone = 'caution';
  }

  if (forecast?.status === 'SWITCH_INCOMING' && forecast.incomingLane && forecast.incomingLane !== myLane) {
    const other = forecast.incomingLane === 'up' ? upLabel : downLabel;
    const eta =
      forecast.etaSec != null && Number.isFinite(forecast.etaSec) ? ` (~${Math.round(forecast.etaSec)}s horizon)` : '';
    bullets.push(
      `Sectional strip shows a switch forming toward ${other}${eta}. Treat open profit as conditional — tighten risk before momentum completes the flip.`,
    );
    tone = 'risk';
  }
  if (forecast?.status === 'EXIT' && forecast.lane === myLane) {
    bullets.push('Structural EXIT is printing on your token — favor flat or minimal carry until the strip clears.');
    tone = 'risk';
  }

  if (directive) {
    if (directive.lane === myLane && directive.action === 'INITIATE') {
      cardBacksHoldThesis = true;
      bullets.push(
        `You said you hold ${myName} and the card still reads INITIATE on ${myName} — read that as hold ${myName}: same thesis as before; follow TP/SL and let the card upgrade to HOLD / ADD before adding size.`,
      );
    } else if (directive.lane === myLane && (directive.action === 'HOLD' || directive.action === 'ADD')) {
      cardBacksHoldThesis = true;
      bullets.push(`Trade card still backs ${myName} (${directive.action}). Let the thesis work; avoid doubling into late chop unless tape confirms.`);
    } else if (directive.lane === myLane && directive.action === 'TRIM') {
      bullets.push('Card suggests TRIM — peel 25–50% on strength; leave a runner only if your worst-case exit is defined.');
      tone = tone === 'constructive' ? 'caution' : tone;
    } else if (directive.lane === myLane && directive.action === 'EXIT') {
      bullets.push('Card is EXIT on your side — prioritize locking or cutting before the bell / tape overshoots.');
      tone = 'risk';
    } else if (
      directive.lane != null &&
      directive.lane !== myLane &&
      (directive.action === 'INITIATE' || directive.action === 'ADD')
    ) {
      const other = directive.lane === 'up' ? upLabel : downLabel;
      bullets.push(
        `Fresh ${directive.action} is on ${other} while you flagged ${myName}. The card is not simultaneously fresh-long your side — defend, cut, or wait for a clean re-sync.`,
      );
      tone = 'risk';
    } else if (directive.action === 'FLIP') {
      bullets.push('Card is FLIP — the prior lane thesis is being retired. Do not “hope through” a structural rotation.');
      tone = 'risk';
    } else if (directive.action === 'STAND_DOWN') {
      bullets.push('STAND_DOWN — sensors disagree. Default: reduce size, widen patience, and wait for a clean re-arm.');
      tone = 'caution';
    }
  }

  if (crossProb != null && Number.isFinite(crossProb)) {
    if (crossProb < 0.38) {
      bullets.push(
        `PTB-cross model is soft (${Math.round(crossProb * 100)}%) — a natural window to pay yourself before conviction fades further.`,
      );
      tone = tone === 'constructive' ? 'caution' : tone;
    } else if (crossProb > 0.62) {
      bullets.push(
        `Cross model remains elevated (${Math.round(crossProb * 100)}%) — you can trail, but keep a hard worst-case exit.`,
      );
    }
  }

  if (levels && !levels.collapsed && directive?.lane === myLane) {
    bullets.push(
      `Bracket anchor: TP near ${(levels.takeProfit * 100).toFixed(1)}¢ (+${levels.takeProfitGain.toFixed(2)} vs ${levels.entry.toFixed(2)} plan) · SL ${(levels.stopLoss * 100).toFixed(1)}¢ (−${levels.stopLossLoss.toFixed(2)}).`,
    );
  } else if (levels?.collapsed) {
    bullets.push(levels.summary);
  }

  if (endsInMs != null && Number.isFinite(endsInMs)) {
    const minLeft = endsInMs / 60_000;
    if (minLeft <= 2) {
      bullets.push('Under ~2m on the bell — slippage and settlement noise dominate; favor flat over squeezing the last tick.');
      tone = 'risk';
    } else if (minLeft <= 8) {
      bullets.push(
        `Late window (~${Math.max(1, Math.round(minLeft))}m left) — shrink new risk; bank green before liquidity thins into the bell.`,
      );
      tone = tone === 'constructive' ? 'caution' : tone;
    } else if (minLeft <= 30) {
      bullets.push('Mid/late window: define the minimum profit you walk with before the next momentum wiggle.');
    }
  }

  // --- "Hold the dip" vs "TP is unrealistic" (confluence, not one print) ----------
  const modelBacksSide =
    directive != null &&
    directive.lane === myLane &&
    (directive.action === 'HOLD' || directive.action === 'ADD' || directive.action === 'INITIATE');
  const softCrossPath = crossProb != null && Number.isFinite(crossProb) && crossProb < 0.38;
  const rotationAwayFromMe =
    (forecast?.status === 'SWITCH_INCOMING' && forecast.incomingLane != null && forecast.incomingLane !== myLane) ||
    (directive != null &&
      directive.lane != null &&
      directive.lane !== myLane &&
      (directive.action === 'INITIATE' || directive.action === 'ADD'));

  if (modelBacksSide && !tapeAgainst && crossProb != null && crossProb >= 0.45) {
    bullets.push(
      `Dips are often noise while the card backs ${myName}, cross is supportive (~${Math.round(crossProb * 100)}%+), and tape isn't fading you — invalidation is your stop / time left, not every counter-tick.`,
    );
  } else if (softCrossPath && (tapeAgainst || rotationAwayFromMe) && !modelBacksSide) {
    bullets.push(
      `TP mostly gone: cross is soft (under ~38%) and the desk leans away from ${myName} without the card still on HOLD/ADD/INITIATE for you — that's when waiting for the old profit target is usually hope; sell strength instead of the mirror move.`,
    );
    tone = 'risk';
  } else if (softCrossPath && modelBacksSide && (tapeAgainst || rotationAwayFromMe)) {
    bullets.push(
      `Cross is soft while the card still backs ${myName} — your TP is harder but not impossible: peel on strength and tighten risk; save full exit for EXIT / FLIP or sectional EXIT on ${myName}, not one bad print.`,
    );
    tone = tone === 'constructive' ? 'caution' : tone;
  }

  if (bullets.length === 0) {
    bullets.push(`Size ${myName} so a fast flip never forces a “hope hold” — let the card + bell govern adds.`);
  }

  if (tone === 'risk') headline = `Protect ${myName} — conditions turning`;
  else if (tone === 'caution') headline = `${myName} — stay nimble`;
  else if (tapeAgainst) headline = `${myName} — desk tape leaning away`;
  else if (cardBacksHoldThesis) headline = `Holding ${myName} — card backs this side`;
  else if (noDirective) headline = `Holding ${myName} — card loading`;
  else headline = `${myName} — lean on the card`;

  return { tone, headline, bullets: bullets.slice(0, 6) };
}
