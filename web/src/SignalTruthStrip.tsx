import type { ReactElement } from 'react';

import type { OperatorVerdict } from './operatorVerdict';
import { buildSignalNarration } from './signalNarrator';
import type { TradeDirective } from './tradeDirective';
import type { SwitchForecast } from './sectionalMomentum';

function confShort(c: SwitchForecast['confidence']): string {
  return c === 'HIGH' ? 'hi' : c === 'MED' ? 'med' : 'lo';
}

function formatBoomKind(kind: string): string {
  return kind.replaceAll('_', ' ').toLowerCase();
}

function TruthPill(props: {
  tag: string;
  children: string;
  tone: 'neutral' | 'live' | 'muted' | 'warn';
}): ReactElement {
  const { tag, children, tone } = props;
  const shell =
    tone === 'live'
      ? 'border-amber-500/45 bg-amber-950/35 text-amber-100/95'
      : tone === 'warn'
        ? 'border-rose-500/40 bg-rose-950/20 text-rose-100/90'
        : tone === 'muted'
          ? 'border-zinc-700/55 bg-zinc-900/35 text-zinc-400'
          : 'border-zinc-600/45 bg-zinc-900/55 text-zinc-200';
  return (
    <span
      className={`inline-flex max-w-full min-w-0 items-baseline gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[9px] leading-tight sm:text-[10px] ${shell}`}
    >
      <span className="shrink-0 font-black uppercase tracking-[0.1em] opacity-70">{tag}</span>
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/**
 * One-line “who wins when” ladder: card verdict → sectional chart → boom confirmation.
 * Shown above the Answer stack so operators can parse conflicts at a glance.
 */
export function SignalTruthStrip(props: {
  tradeDirective: TradeDirective | null;
  operatorVerdict: OperatorVerdict;
  switchForecast: SwitchForecast;
  boomActive: boolean;
  boomKind: string | null;
  /** Lane attached to the active boom (if any). */
  boomLane?: 'up' | 'down' | null;
  upLabel: string;
  downLabel: string;
  /** Structural hints run, but execution defers to the trade card (e.g. stand-down). */
  executionClash?: boolean;
  /** Sectional WAIT while card GO — copy explains both layers. */
  tapeWaitCardGo?: boolean;
  /** Machine vote lane; when it disagrees with the card lane, we surface it on the Card pill. */
  machineFocusLane?: 'up' | 'down' | null;
  machineAgreementPct?: number | null;
  /** Near bell — sizing and urgency context. */
  inSettlement?: boolean;
}): ReactElement {
  const {
    tradeDirective,
    operatorVerdict,
    switchForecast,
    boomActive,
    boomKind,
    boomLane = null,
    upLabel,
    downLabel,
    executionClash = false,
    tapeWaitCardGo = false,
    machineFocusLane = null,
    machineAgreementPct = null,
    inSettlement = false,
  } = props;

  const laneLab = (lane: 'up' | 'down') => (lane === 'up' ? upLabel : downLabel);

  // When the verdict is STAND_DOWN, do not append " · UP" — it reads like "go UP"
  // while the card says don't trade (lane is only the model line, not permission).
  const cardLanePart =
    tradeDirective?.lane && !operatorVerdict.isStandDown ? ` · ${laneLab(tradeDirective.lane)}` : '';
  let cardBody =
    tradeDirective == null ? '—' : `${operatorVerdict.bigVerb}${cardLanePart}`;

  const tapeSkewsCard =
    tradeDirective?.lane != null &&
    machineFocusLane != null &&
    tradeDirective.lane !== machineFocusLane;
  if (tapeSkewsCard) {
    const pct =
      machineAgreementPct != null && Number.isFinite(machineAgreementPct)
        ? ` ${Math.round(machineAgreementPct)}%`
        : '';
    cardBody += ` · tape→${laneLab(machineFocusLane)}${pct}`;
  }
  if (inSettlement && tradeDirective != null) {
    cardBody += ' · settle';
  }

  const sf = switchForecast;
  const confSuffix =
    sf.status !== 'WAIT' ? ` · ${confShort(sf.confidence)}` : '';
  let chartBody = '—';
  if (sf.status === 'SWITCH_INCOMING' && sf.incomingLane) {
    const lab = laneLab(sf.incomingLane);
    const eta = sf.etaSec != null && Number.isFinite(sf.etaSec) ? ` ~${Math.round(sf.etaSec)}s` : '';
    chartBody = `switch → ${lab}${eta}${confSuffix}`;
  } else if (sf.status === 'EXIT' && sf.lane) {
    chartBody = `EXIT · ${laneLab(sf.lane)}${confSuffix}`;
  } else if ((sf.status === 'GO_IN' || sf.status === 'STAY_IN') && sf.lane) {
    chartBody = `${sf.status === 'STAY_IN' ? 'stay' : 'go'} · ${laneLab(sf.lane)}${confSuffix}`;
  } else if (sf.status === 'WAIT') {
    const h = sf.headline.replace(/\bUP\b/g, upLabel).replace(/\bDOWN\b/g, downLabel);
    const condensed = h.replace(/^WAIT\s*[—–-]\s*/i, '').trim();
    chartBody = condensed ? `slice wait · ${condensed}` : 'wait / context';
  }

  const boomBody =
    boomActive && boomKind ? formatBoomKind(boomKind) : 'off';

  const titleBits = [
    'Order: card wins sizing and guards; chart is early structure; boom is rare confirmation.',
  ];
  if (executionClash) {
    titleBits.push('Stand-down: only the Answer card governs sizing and clicks; tape below is context.');
  }
  if (tapeWaitCardGo && !executionClash) {
    titleBits.push('Tape slices can be WAIT while the card GO uses the wider model — card row governs execution.');
  }
  if (tapeSkewsCard && machineFocusLane) {
    titleBits.push(`Machine vote leans ${laneLab(machineFocusLane)}.`);
  }

  const narration = buildSignalNarration({
    upLabel,
    downLabel,
    tradeDirective,
    switchForecast: sf,
    machineFocusLane,
    boomActive,
    boomLane,
    executionClash,
    tapeWaitCardGo,
  });
  titleBits.push(narration.headline);

  const narrationClass =
    narration.tone === 'split'
      ? 'text-amber-200/90'
      : narration.tone === 'calm'
        ? 'text-sky-200/90'
        : 'text-zinc-500';

  return (
    <div
      role="group"
      aria-label={`Signal stack: trade card, sectional chart, boom. ${narration.headline}`}
      className={`mb-2 rounded-lg px-2 py-1.5 text-[9px] leading-snug text-zinc-400 sm:px-2.5 sm:text-[10px] ${
        executionClash
          ? 'border border-rose-500/35 bg-rose-950/12'
          : tapeWaitCardGo
            ? 'border border-amber-500/35 bg-amber-950/12'
            : 'border border-zinc-700/60 bg-zinc-950/50'
      }`}
      title={titleBits.join(' ')}
    >
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-black uppercase tracking-[0.14em] text-zinc-500">Signal stack</span>
        {executionClash ? (
          <span className="rounded border border-rose-500/30 bg-rose-950/40 px-1 py-px font-mono text-[8px] font-semibold uppercase tracking-wide text-rose-200/95 sm:text-[9px]">
            Card wins exec
          </span>
        ) : tapeWaitCardGo ? (
          <span className="rounded border border-amber-500/30 bg-amber-950/40 px-1 py-px font-mono text-[8px] font-semibold uppercase tracking-wide text-amber-200/95 sm:text-[9px]">
            Card leads · tape WAIT
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-stretch gap-1.5">
        <TruthPill tag="Card" tone={executionClash ? 'warn' : 'neutral'}>
          {cardBody}
        </TruthPill>
        <TruthPill tag="Chart" tone={sf.status === 'WAIT' ? 'muted' : 'neutral'}>
          {chartBody}
        </TruthPill>
        <TruthPill tag="Boom" tone={boomActive ? 'live' : 'muted'}>
          {boomBody}
        </TruthPill>
      </div>
      <p className={`mt-1.5 border-t border-zinc-800/80 pt-1.5 font-sans text-[10px] leading-snug sm:text-[11px] ${narrationClass}`}>
        {narration.headline}
      </p>
    </div>
  );
}
