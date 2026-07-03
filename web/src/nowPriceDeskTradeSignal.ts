/**
 * One fused "main desk trade" readout for the Now Price Signals panel.
 * Priority: execution ENTER → entry moment ENTER_NOW → execution ALERT → direction → advisory.
 */

import type { DirectionEngineSignal } from './directionEngine';
import type { ExecutionSignal } from './executionSignal';
import type { EntryMoment } from './entryMoment';
import type { PositionTpOutlook } from './positionTpOutlook';
import type { BuySideAdvisory } from './shouldBuyWhichSide';
import type { ContractLeadSignal } from './contractLeadSignal';
import type { PressureTiming } from './pressureTiming';

export type NowPriceDeskTradePhase = 'ENTER' | 'ALERT' | 'LEAN' | 'WAIT' | 'NO_TRADE';
export type NowPriceDeskTradeUrgency = 'now' | 'soon' | 'wait' | 'stand_down';

export type NowPriceDeskTradeSignal = {
  phase: NowPriceDeskTradePhase;
  lane: 'up' | 'down' | null;
  laneLabel: string | null;
  headline: string;
  exactAction: string;
  confidencePct: number | null;
  confirmPct: number | null;
  confirmSecRemaining: number | null;
  readinessPct: number;
  tpHitProbPct: number | null;
  tpCents: number | null;
  urgency: NowPriceDeskTradeUrgency;
  blockers: string[];
  canTrade: boolean;
  tone: 'up' | 'down' | 'warn' | 'flat';
  emoji: string;
  source: 'execution' | 'entry_moment' | 'direction' | 'advisory' | 'none';
};

function laneName(lane: 'up' | 'down', upLabel: string, downLabel: string): string {
  return lane === 'up' ? upLabel : downLabel;
}

function advisoryLane(advisory: BuySideAdvisory | null): 'up' | 'down' | null {
  if (advisory?.verdict === 'BUY_UP') return 'up';
  if (advisory?.verdict === 'BUY_DOWN') return 'down';
  return null;
}

function failedGateLabels(execution: ExecutionSignal | null, max = 3): string[] {
  if (!execution) return [];
  return execution.gates.filter((g) => !g.pass).slice(0, max).map((g) => g.label);
}

function toneForLane(lane: 'up' | 'down' | null): NowPriceDeskTradeSignal['tone'] {
  if (lane === 'up') return 'up';
  if (lane === 'down') return 'down';
  return 'flat';
}

function isStrongDeskAdvisory(advisory: BuySideAdvisory | null, lane: 'up' | 'down' | null): boolean {
  if (!advisory || !lane || advisory.verdict === 'NEITHER') return false;
  if (advisoryLane(advisory) !== lane) return false;
  if (advisory.cautionFresh) return false;
  if (advisory.confidence === 'HIGH') return true;
  return advisory.confidence === 'MED' && advisory.confidencePct >= 62;
}

function timingBlockersFromEntryMoment(entryMoment: EntryMoment | null): string[] {
  if (!entryMoment) return [];
  return entryMoment.checks
    .filter((c) => !c.pass && (c.id === 'pressure' || c.id === 'overextension' || c.id === 'whipsaw'))
    .map((c) => c.label);
}

function isChasingEntryMoment(entryMoment: EntryMoment | null): boolean {
  if (!entryMoment) return false;
  return (
    entryMoment.phase === 'WAIT_PULLBACK' ||
    entryMoment.checks.some((c) => c.id === 'pressure' && !c.pass)
  );
}

function hasAlignedDeskPick(advisory: BuySideAdvisory | null, lane: 'up' | 'down'): boolean {
  return advisory != null && advisory.verdict !== 'NEITHER' && advisoryLane(advisory) === lane;
}

function deskLeanReadiness(args: {
  advisory: BuySideAdvisory | null;
  directionConfidencePct: number;
  entryMoment: EntryMoment | null;
  chasing: boolean;
  strongPick: boolean;
}): number {
  const { advisory, directionConfidencePct, entryMoment, chasing, strongPick } = args;
  if (strongPick && advisory) {
    return Math.max(52, advisory.confidencePct - (chasing ? 10 : 6));
  }
  if (entryMoment?.lane && hasAlignedDeskPick(advisory, entryMoment.lane) && advisory) {
    return Math.max(48, advisory.confidencePct - (chasing ? 14 : 8));
  }
  return entryMoment?.readinessPct ?? Math.min(70, directionConfidencePct);
}

function deskLeanExactAction(args: {
  label: string;
  lane: 'up' | 'down';
  advisory: BuySideAdvisory | null;
  entryMoment: EntryMoment | null;
  directionHeadline: string;
  chasing: boolean;
  strongPick: boolean;
  blockers: string[];
}): string {
  const { label, advisory, entryMoment, directionHeadline, chasing, strongPick, blockers } = args;
  if (chasing && (strongPick || hasAlignedDeskPick(advisory, args.lane))) {
    const conf =
      advisory?.confidence === 'HIGH' ? 'Strong' : advisory?.confidence === 'MED' ? 'Solid' : 'Desk';
    return `${conf} ${label} edge — move already ran. Join on bid, not wide ask. Hunt EARLY pressure (<4pp on 10s) for cleaner entry.`;
  }
  if (entryMoment?.exactAction && !isChasingEntryMoment(entryMoment)) {
    return entryMoment.exactAction;
  }
  if (advisory?.recommendation && hasAlignedDeskPick(advisory, args.lane)) {
    return blockers.length
      ? `${advisory.recommendation} Waiting on ${blockers.join(', ')}.`
      : advisory.recommendation;
  }
  return blockers.length ? `${directionHeadline} — need: ${blockers.join(', ')}.` : directionHeadline;
}

function contractLeadLane(
  lead: ContractLeadSignal,
  upLabel: string,
  downLabel: string,
): 'up' | 'down' | null {
  const label = lead.sideLabel.trim().toUpperCase();
  if (label === upLabel.toUpperCase() || label === 'UP') return 'up';
  if (label === downLabel.toUpperCase() || label === 'DOWN') return 'down';
  return null;
}

export function buildNowPriceDeskTradeSignal(args: {
  execution: ExecutionSignal | null;
  entryMoment: EntryMoment | null;
  advisory: BuySideAdvisory | null;
  directionEngine: DirectionEngineSignal | null;
  tpOutlook: PositionTpOutlook | null;
  contractLead?: ContractLeadSignal | null;
  pressureTiming?: PressureTiming | null;
  upLabel: string;
  downLabel: string;
}): NowPriceDeskTradeSignal {
  const {
    execution,
    entryMoment,
    advisory,
    directionEngine,
    tpOutlook,
    contractLead = null,
    pressureTiming = null,
    upLabel,
    downLabel,
  } = args;

  const tpHitProbPct =
    tpOutlook != null && Number.isFinite(tpOutlook.tpHitProb01)
      ? Math.round(tpOutlook.tpHitProb01 * 100)
      : null;
  const tpCents = tpOutlook?.tpCents ?? null;

  const baseBlockers = failedGateLabels(execution);

  // --- Execution ENTER (highest) ---
  if (execution?.phase === 'ENTER') {
    const lane: 'up' | 'down' =
      execution.verdict === 'ENTER_UP' ? 'up' : execution.verdict === 'ENTER_DOWN' ? 'down' : execution.proposedLane ?? 'up';
    const label = laneName(lane, upLabel, downLabel);
    const tpNote =
      tpHitProbPct != null && tpCents != null
        ? ` TP ~${tpHitProbPct}% to tag ${tpCents.toFixed(1)}¢.`
        : '';
    return {
      phase: 'ENTER',
      lane,
      laneLabel: label,
      headline: `ENTER ${label}`,
      exactAction: `${execution.summaryLine || execution.headline}${tpNote}`,
      confidencePct: directionEngine?.confidencePct ?? advisory?.confidencePct ?? null,
      confirmPct: 100,
      confirmSecRemaining: 0,
      readinessPct: entryMoment?.readinessPct ?? 100,
      tpHitProbPct,
      tpCents,
      urgency: 'now',
      blockers: [],
      canTrade: true,
      tone: toneForLane(lane),
      emoji: execution.emoji,
      source: 'execution',
    };
  }

  // --- Entry moment GO (operator truth when armed) ---
  if (entryMoment?.phase === 'ENTER_NOW' && entryMoment.lane) {
    const label = laneName(entryMoment.lane, upLabel, downLabel);
    const tpNote =
      tpHitProbPct != null && tpCents != null
        ? ` ~${tpHitProbPct}% TP odds at ${tpCents.toFixed(1)}¢.`
        : '';
    return {
      phase: 'ENTER',
      lane: entryMoment.lane,
      laneLabel: label,
      headline: entryMoment.headline,
      exactAction: `${entryMoment.exactAction}${tpNote}`,
      confidencePct: advisory?.confidencePct ?? directionEngine?.confidencePct ?? null,
      confirmPct: 100,
      confirmSecRemaining: 0,
      readinessPct: entryMoment.readinessPct,
      tpHitProbPct,
      tpCents,
      urgency: 'now',
      blockers: [],
      canTrade: true,
      tone: toneForLane(entryMoment.lane),
      emoji: entryMoment.lane === 'up' ? '🟢' : '🔴',
      source: 'entry_moment',
    };
  }

  // --- Contract lead inside momentum (10s window) ---
  if (
    contractLead?.phase === 'ENTER' &&
    (pressureTiming === 'EARLY' || pressureTiming === 'BUILDING')
  ) {
    const lane = contractLeadLane(contractLead, upLabel, downLabel) ?? advisoryLane(advisory);
    if (lane) {
      const label = laneName(lane, upLabel, downLabel);
      const aligned = !advisory || advisoryLane(advisory) === lane || advisory.verdict === 'NEITHER';
      const tpNote =
        tpHitProbPct != null && tpCents != null
          ? ` TP ~${tpHitProbPct}% to ${tpCents.toFixed(1)}¢.`
          : '';
      if (aligned) {
        return {
          phase: entryMoment?.phase === 'ENTER_NOW' || entryMoment?.canExecute ? 'ENTER' : 'ALERT',
          lane,
          laneLabel: label,
          headline:
            entryMoment?.phase === 'ENTER_NOW'
              ? entryMoment.headline
              : `ENTER ${label} — inside momentum`,
          exactAction: `${contractLead.actionLine} ${contractLead.reasonLine}${tpNote}`,
          confidencePct: advisory?.confidencePct ?? directionEngine?.confidencePct ?? null,
          confirmPct: entryMoment?.confirmSecRemaining != null ? entryMoment.readinessPct : null,
          confirmSecRemaining: entryMoment?.confirmSecRemaining ?? null,
          readinessPct: entryMoment?.readinessPct ?? Math.min(92, (advisory?.confidencePct ?? 70) + 8),
          tpHitProbPct,
          tpCents,
          urgency: 'now',
          blockers: [],
          canTrade: entryMoment?.canExecute === true || contractLead.phase === 'ENTER',
          tone: toneForLane(lane),
          emoji: '⚡',
          source: 'entry_moment',
        };
      }
    }
  }

  // --- Entry moment confirming / alert (before generic execution ALERT) ---
  if (
    entryMoment &&
    (entryMoment.phase === 'CONFIRMING' || entryMoment.phase === 'ALERT') &&
    entryMoment.lane
  ) {
    const label = laneName(entryMoment.lane, upLabel, downLabel);
    const leanHeadline = entryMoment.headline.toUpperCase().startsWith('LEAN');
    const momentumHeadline = entryMoment.headline.toUpperCase().includes('MOMENTUM');
    const strongAdvisory = isStrongDeskAdvisory(advisory, entryMoment.lane);
    const failedChecks = entryMoment.checks.filter((c) => !c.pass);
    const blockers =
      leanHeadline && strongAdvisory
        ? failedChecks.filter((c) => c.id !== 'pressure' && c.id !== 'overextension').map((c) => c.label)
        : failedChecks.slice(0, 3).map((c) => c.label);
    const phase: NowPriceDeskTradePhase =
      entryMoment.canExecute
        ? 'ENTER'
        : momentumHeadline && entryMoment.phase === 'CONFIRMING'
          ? 'ALERT'
          : leanHeadline
            ? 'LEAN'
            : 'ALERT';
    return {
      phase,
      lane: entryMoment.lane,
      laneLabel: label,
      headline: entryMoment.headline,
      exactAction: entryMoment.exactAction,
      confidencePct: advisory?.confidencePct ?? directionEngine?.confidencePct ?? null,
      confirmPct: entryMoment.readinessPct,
      confirmSecRemaining: entryMoment.confirmSecRemaining,
      readinessPct: entryMoment.readinessPct,
      tpHitProbPct,
      tpCents,
      urgency: entryMoment.urgency,
      blockers,
      canTrade: entryMoment.canExecute,
      tone: toneForLane(entryMoment.lane),
      emoji: momentumHeadline ? '⚡' : leanHeadline ? '⚡' : '⏳',
      source: 'entry_moment',
    };
  }

  // --- Execution ALERT (confirming) ---
  if (execution?.phase === 'ALERT') {
    const lane =
      execution.proposedLane ??
      (execution.bias?.direction === 'up' ? 'up' : execution.bias?.direction === 'down' ? 'down' : advisoryLane(advisory));
    const label = lane != null ? laneName(lane, upLabel, downLabel) : null;
    const confirmPct = Math.min(
      100,
      Math.round((execution.confirmHeldMs / Math.max(1, execution.confirmRequiredMs)) * 100),
    );
    const remainSec = Math.max(0, Math.ceil((execution.confirmRequiredMs - execution.confirmHeldMs) / 1000));
    const blockerText = baseBlockers.length ? ` Blocked: ${baseBlockers.join(' · ')}.` : '';
    return {
      phase: 'ALERT',
      lane,
      laneLabel: label,
      headline: label ? `ALERT ${label}` : 'ALERT',
      exactAction: `${execution.headline} Hold ${remainSec > 0 ? `${remainSec}s` : 'confirmation'} before entry.${blockerText}`,
      confidencePct: directionEngine?.confidencePct ?? advisory?.confidencePct ?? null,
      confirmPct,
      confirmSecRemaining: remainSec > 0 ? remainSec : null,
      readinessPct: entryMoment?.readinessPct ?? confirmPct,
      tpHitProbPct,
      tpCents,
      urgency: 'soon',
      blockers: baseBlockers,
      canTrade: false,
      tone: lane != null ? toneForLane(lane) : 'warn',
      emoji: execution.emoji,
      source: 'execution',
    };
  }

  // --- Entry moment pullback with live desk pick ---
  if (entryMoment?.phase === 'WAIT_PULLBACK' && entryMoment.lane) {
    const lane = entryMoment.lane;
    const label = laneName(lane, upLabel, downLabel);
    const strongPick = isStrongDeskAdvisory(advisory, lane);
    const alignedPick = hasAlignedDeskPick(advisory, lane);
    if (strongPick || (alignedPick && advisory && advisory.confidencePct >= 58)) {
      const chasing = true;
      const blockers = baseBlockers;
      return {
        phase: blockers.length > 0 ? 'WAIT' : 'LEAN',
        lane,
        laneLabel: label,
        headline: `LEAN ${label}`,
        exactAction: deskLeanExactAction({
          label,
          lane,
          advisory,
          entryMoment,
          directionHeadline: directionEngine?.headline ?? `Lean ${label}`,
          chasing,
          strongPick: strongPick || alignedPick,
          blockers,
        }),
        confidencePct: advisory?.confidencePct ?? directionEngine?.confidencePct ?? null,
        confirmPct: null,
        confirmSecRemaining: null,
        readinessPct: deskLeanReadiness({
          advisory,
          directionConfidencePct: directionEngine?.confidencePct ?? 60,
          entryMoment,
          chasing,
          strongPick: strongPick || alignedPick,
        }),
        tpHitProbPct,
        tpCents,
        urgency: blockers.length > 0 ? 'wait' : 'soon',
        blockers,
        canTrade: false,
        tone: toneForLane(lane),
        emoji: '⚡',
        source: 'entry_moment',
      };
    }
  }

  // --- Direction engine lean ---
  if (directionEngine?.verdict === 'ENTER_UP' || directionEngine?.verdict === 'ENTER_DOWN') {
    const lane: 'up' | 'down' = directionEngine.verdict === 'ENTER_UP' ? 'up' : 'down';
    const label = laneName(lane, upLabel, downLabel);
    const strongPick = isStrongDeskAdvisory(advisory, lane);
    const alignedPick = hasAlignedDeskPick(advisory, lane);
    const chasing = isChasingEntryMoment(entryMoment);
    const timingBlockers = timingBlockersFromEntryMoment(entryMoment);
    const blockers = strongPick || alignedPick ? baseBlockers : [...baseBlockers, ...timingBlockers];
    const phase: NowPriceDeskTradePhase =
      baseBlockers.length > 0 ? 'WAIT' : strongPick || alignedPick || !chasing ? 'LEAN' : 'WAIT';
    const headline = directionEngine.hardRule ? `HARD LEAN ${label}` : `LEAN ${label}`;
    return {
      phase,
      lane,
      laneLabel: label,
      headline,
      exactAction: deskLeanExactAction({
        label,
        lane,
        advisory,
        entryMoment,
        directionHeadline: directionEngine.headline,
        chasing,
        strongPick: strongPick || alignedPick,
        blockers,
      }),
      confidencePct: advisory?.confidencePct ?? directionEngine.confidencePct,
      confirmPct: null,
      confirmSecRemaining: null,
      readinessPct: deskLeanReadiness({
        advisory,
        directionConfidencePct: directionEngine.confidencePct,
        entryMoment,
        chasing,
        strongPick: strongPick || alignedPick,
      }),
      tpHitProbPct,
      tpCents,
      urgency: phase === 'LEAN' ? 'soon' : 'wait',
      blockers,
      canTrade: false,
      tone: toneForLane(lane),
      emoji: phase === 'LEAN' ? '⚡' : directionEngine.emoji,
      source: 'direction',
    };
  }

  // --- Advisory pick without execution go ---
  const advLane = advisoryLane(advisory);
  if (advLane && advisory && advisory.verdict !== 'NEITHER') {
    const label = laneName(advLane, upLabel, downLabel);
    const strongPick = isStrongDeskAdvisory(advisory, advLane);
    const timingBlockers = timingBlockersFromEntryMoment(entryMoment);
    const blockers = strongPick ? baseBlockers : [...baseBlockers, ...timingBlockers];
    const phase: NowPriceDeskTradePhase =
      baseBlockers.length > 0
        ? 'WAIT'
        : strongPick
          ? entryMoment?.phase === 'WAIT_PULLBACK' || timingBlockers.length > 0
            ? 'LEAN'
            : 'ALERT'
          : blockers.length
            ? 'WAIT'
            : 'ALERT';
    const waitAction = strongPick
      ? deskLeanExactAction({
          label,
          lane: advLane,
          advisory,
          entryMoment,
          directionHeadline: advisory.recommendation,
          chasing: entryMoment?.phase === 'WAIT_PULLBACK' || timingBlockers.length > 0,
          strongPick: true,
          blockers: baseBlockers,
        })
      : entryMoment?.exactAction ??
        (blockers.length
          ? `Desk pick ${label} — waiting on ${blockers.join(', ')}.`
          : advisory.recommendation);
    return {
      phase,
      lane: advLane,
      laneLabel: label,
      headline: phase === 'LEAN' ? `LEAN ${label}` : `BUY ${label}`,
      exactAction: waitAction,
      confidencePct: advisory.confidencePct,
      confirmPct: null,
      confirmSecRemaining: entryMoment?.confirmSecRemaining ?? null,
      readinessPct: strongPick
        ? Math.max(advisory.confidencePct - 10, entryMoment?.readinessPct ?? 0)
        : (entryMoment?.readinessPct ?? advisory.confidencePct),
      tpHitProbPct,
      tpCents,
      urgency: strongPick && baseBlockers.length === 0 ? 'soon' : (entryMoment?.urgency ?? (blockers.length ? 'wait' : 'soon')),
      blockers,
      canTrade: false,
      tone: toneForLane(advLane),
      emoji: phase === 'LEAN' ? '⚡' : advLane === 'up' ? '🟢' : '🔴',
      source: 'advisory',
    };
  }

  // --- Stand down / no trade ---
  const noTrade =
    execution?.phase === 'NO_TRADE' ||
    entryMoment?.phase === 'NO_TRADE' ||
    advisory?.verdict === 'NEITHER' ||
    directionEngine?.verdict === 'NO_TRADE';

  return {
    phase: noTrade ? 'NO_TRADE' : 'WAIT',
    lane: null,
    laneLabel: null,
    headline: noTrade ? 'NO TRADE' : 'WAIT',
    exactAction:
      entryMoment?.exactAction ??
      execution?.summaryLine ??
      advisory?.recommendation ??
      directionEngine?.headline ??
      'Wait for PTB + spot tape and a clear UP/DOWN lean.',
    confidencePct: directionEngine?.confidencePct ?? advisory?.confidencePct ?? null,
    confirmPct: null,
    confirmSecRemaining: null,
    readinessPct: entryMoment?.readinessPct ?? 0,
    tpHitProbPct: null,
    tpCents: null,
    urgency: noTrade ? 'stand_down' : 'wait',
    blockers: baseBlockers,
    canTrade: false,
    tone: noTrade ? 'flat' : 'warn',
    emoji: noTrade ? '⚪' : '🔵',
    source: 'none',
  };
}
