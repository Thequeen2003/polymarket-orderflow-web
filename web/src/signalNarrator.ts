import type { TradeDirective } from './tradeDirective';
import type { SwitchForecast } from './sectionalMomentum';

export type SignalNarrationTone = 'calm' | 'split' | 'muted';

export type SignalNarration = {
  tone: SignalNarrationTone;
  /** Single readable sentence; no HTML. */
  headline: string;
};

type Lane = 'up' | 'down';

type BiasEntry = { source: string; lane: Lane };

function chartStructuralBias(sf: SwitchForecast): { lane: Lane | null; exitFrom: Lane | null } {
  if (sf.status === 'EXIT' && sf.lane) {
    return { lane: null, exitFrom: sf.lane };
  }
  if (sf.status === 'SWITCH_INCOMING' && sf.incomingLane) {
    return { lane: sf.incomingLane, exitFrom: null };
  }
  if ((sf.status === 'GO_IN' || sf.status === 'STAY_IN') && sf.lane) {
    return { lane: sf.lane, exitFrom: null };
  }
  return { lane: null, exitFrom: null };
}

/**
 * One plain-language line that reconciles card, sectional chart, tape vote, and boom
 * so operators see a single “story” when layers disagree.
 */
export function buildSignalNarration(args: {
  upLabel: string;
  downLabel: string;
  tradeDirective: TradeDirective | null;
  switchForecast: SwitchForecast;
  machineFocusLane: Lane | null;
  boomActive: boolean;
  boomLane: Lane | null;
  executionClash: boolean;
  /**
   * Sectional forecast is WAIT while the trade card already issued GO — not a bug;
   * card uses sensors the slice summary has not resolved yet.
   */
  tapeWaitCardGo?: boolean;
}): SignalNarration {
  const {
    upLabel,
    downLabel,
    tradeDirective,
    switchForecast: sf,
    machineFocusLane,
    boomActive,
    boomLane,
    executionClash,
    tapeWaitCardGo = false,
  } = args;

  const L = (lane: Lane) => (lane === 'up' ? upLabel : downLabel);

  const cardLane = tradeDirective?.lane ?? null;

  if (
    tapeWaitCardGo &&
    sf.status === 'WAIT' &&
    cardLane &&
    !executionClash &&
    (tradeDirective?.action === 'INITIATE' || tradeDirective?.action === 'ADD')
  ) {
    return {
      tone: 'split',
      headline: `Tape WAIT (no dominant slice), card GO ${L(cardLane)} — card fuses spot + PTB + book; this banner is the sectional window only.`,
    };
  }
  const { lane: chartLane, exitFrom } = chartStructuralBias(sf);

  const biases: BiasEntry[] = [];
  // Stand-down: card lane is not an "enter this side" vote — only chart/tape/boom count for alignment.
  if (cardLane && !executionClash) biases.push({ source: 'Card', lane: cardLane });
  if (chartLane) biases.push({ source: 'Chart', lane: chartLane });
  if (machineFocusLane) biases.push({ source: 'Tape', lane: machineFocusLane });
  if (boomActive && boomLane) biases.push({ source: 'Boom', lane: boomLane });

  const standSuffix = executionClash
    ? ' Answer card is in stand-down — only it governs sizing and clicks.'
    : '';

  if (exitFrom) {
    const bits = [`Chart wants EXIT from ${L(exitFrom)}`];
    if (cardLane) {
      bits.push(
        cardLane === exitFrom
          ? `trade card still ${L(cardLane)}`
          : `trade card on ${L(cardLane)}`,
      );
    }
    if (machineFocusLane) {
      bits.push(
        machineFocusLane === exitFrom
          ? `tape also stresses ${L(exitFrom)}`
          : `tape leans ${L(machineFocusLane)}`,
      );
    }
    return {
      tone: 'split',
      headline: `${bits.join(' · ')}.${standSuffix}`.trim(),
    };
  }

  if (biases.length === 0) {
    if (sf.status === 'WAIT') {
      return {
        tone: 'muted',
        headline: `Chart is idle (wait).${tradeDirective == null ? ' No trade card lane.' : ''}`.trim(),
      };
    }
    return {
      tone: 'muted',
      headline: 'No lane votes in view — wait for chart, tape, or a trade card.',
    };
  }

  const upSources = biases.filter((b) => b.lane === 'up').map((b) => b.source);
  const downSources = biases.filter((b) => b.lane === 'down').map((b) => b.source);

  if (upSources.length > 0 && downSources.length === 0) {
    return {
      tone: 'calm',
      headline: `Same story — all point ${L('up')}: ${upSources.join(', ')}.${standSuffix}`.trim(),
    };
  }
  if (downSources.length > 0 && upSources.length === 0) {
    return {
      tone: 'calm',
      headline: `Same story — all point ${L('down')}: ${downSources.join(', ')}.${standSuffix}`.trim(),
    };
  }

  const upStr = `${upSources.join('+')}→${L('up')}`;
  const downStr = `${downSources.join('+')}→${L('down')}`;
  return {
    tone: 'split',
    headline: `Different stories — ${upStr} vs ${downStr}.${standSuffix}`.trim(),
  };
}
