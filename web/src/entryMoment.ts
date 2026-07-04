/**
 * Entry moment — one fused readout for *exactly when* to pull the trigger.
 *
 * Combines Should-I-buy advisory, execution desk phase, directive stability,
 * pressure timing, and optional take-signal plan into a single checklist + action line.
 */

import type { DirectiveStability } from './directiveStability';
import type { ExecutionSignal } from './executionSignal';
import { EXEC_CONFIRM_HOLD_MS } from './executionSignal';
import type { PressureTiming } from './pressureTiming';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { BuySideAdvisory } from './shouldBuyWhichSide';
import type { TakeSignalPlan } from './takeSignalDesk';
import type { TradeDirective } from './tradeDirective';
import { directiveAllowsTakeSignal } from './takeSignalStability';
import type { ContractLeadSignal } from './contractLeadSignal';

export type EntryMomentPhase =
  | 'ENTER_NOW'
  | 'CONFIRMING'
  | 'ALERT'
  | 'WAIT_PULLBACK'
  | 'WAIT_SETUP'
  | 'NO_TRADE';

export type EntryMomentUrgency = 'now' | 'soon' | 'wait' | 'stand_down';

export type EntryMomentCheck = {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
};

export type EntryMoment = {
  phase: EntryMomentPhase;
  lane: 'up' | 'down' | null;
  headline: string;
  /** One sentence — what to do right now. */
  exactAction: string;
  /** 0–100 how close to a clean entry. */
  readinessPct: number;
  /** Seconds left on execution confirm hold (ALERT/CONFIRMING only). */
  confirmSecRemaining: number | null;
  checks: EntryMomentCheck[];
  urgency: EntryMomentUrgency;
  /** True only when phase is ENTER_NOW. */
  canExecute: boolean;
};

export type EntryMomentInput = {
  advisory: BuySideAdvisory | null;
  execution: ExecutionSignal | null;
  stability?: DirectiveStability | null;
  directive?: TradeDirective | null;
  takePlan?: TakeSignalPlan | null;
  machine?: SpotPtbMachineReadout | null;
  pressureTiming?: PressureTiming | null;
  contractLead?: ContractLeadSignal | null;
  upLabel?: string;
  downLabel?: string;
  /** Sports / book-only — no execution desk. */
  bookOnly?: boolean;
};

function laneLabel(lane: 'up' | 'down', upLabel?: string, downLabel?: string): string {
  return lane === 'up' ? (upLabel ?? 'UP').toUpperCase() : (downLabel ?? 'DOWN').toUpperCase();
}

function advisoryLane(advisory: BuySideAdvisory | null): 'up' | 'down' | null {
  if (advisory?.verdict === 'BUY_UP') return 'up';
  if (advisory?.verdict === 'BUY_DOWN') return 'down';
  return null;
}

function fmtEntryCents(entry01: number | null | undefined): string | null {
  if (entry01 == null || !Number.isFinite(entry01)) return null;
  return `${(entry01 * 100).toFixed(1)}¢`;
}

function contractLeadLane(
  lead: ContractLeadSignal,
  upLabel?: string,
  downLabel?: string,
): 'up' | 'down' | null {
  const label = lead.sideLabel.trim().toUpperCase();
  const up = (upLabel ?? 'UP').toUpperCase();
  const down = (downLabel ?? 'DOWN').toUpperCase();
  if (label === up || label === 'UP') return 'up';
  if (label === down || label === 'DOWN') return 'down';
  return null;
}

function checksFromExecution(
  execution: ExecutionSignal,
  lane: 'up' | 'down' | null,
  confirmPass: boolean,
): EntryMomentCheck[] {
  const checks: EntryMomentCheck[] = execution.gates.map((g) => ({
    id: g.id,
    label: g.label,
    pass: g.pass,
    detail: g.detail,
  }));
  if (execution.baseAlert && !checks.some((c) => c.id === 'confirmHold')) {
    checks.push({
      id: 'confirmHold',
      label: '7s confirmation',
      pass: confirmPass,
      detail: confirmPass
        ? `Held ${Math.round((execution.confirmHeldMs ?? 0) / 1000)}s`
        : `${Math.round((execution.confirmHeldMs ?? 0) / 1000)}s / ${Math.round((execution.confirmRequiredMs ?? EXEC_CONFIRM_HOLD_MS) / 1000)}s`,
    });
  }
  if (lane && execution.proposedLane && execution.proposedLane !== lane) {
    checks.unshift({
      id: 'laneMatch',
      label: 'Lane match',
      pass: false,
      detail: `Execution favors ${execution.proposedLane.toUpperCase()} — advisory picked ${lane.toUpperCase()}`,
    });
  }
  return checks;
}

function readinessFromChecks(checks: EntryMomentCheck[]): number {
  if (!checks.length) return 0;
  const passed = checks.filter((c) => c.pass).length;
  return Math.round((passed / checks.length) * 100);
}

function bookOnlyMoment(args: {
  advisory: BuySideAdvisory;
  lane: 'up' | 'down';
  stability: DirectiveStability | null | undefined;
  directive: TradeDirective | null | undefined;
  takePlan: TakeSignalPlan | null | undefined;
  upLabel?: string;
  downLabel?: string;
}): EntryMoment {
  const { advisory, lane, stability, directive, takePlan, upLabel, downLabel } = args;
  const name = laneLabel(lane, upLabel, downLabel);
  const dirGate = directiveAllowsTakeSignal(stability ?? null, directive ?? null);

  const checks: EntryMomentCheck[] = [
    {
      id: 'side',
      label: 'Side picked',
      pass: true,
      detail: `BUY ${name} · ${advisory.confidencePct}% conf`,
    },
    {
      id: 'conviction',
      label: 'Conviction',
      pass: advisory.confidence !== 'LOW',
      detail:
        advisory.confidence === 'HIGH'
          ? 'HIGH confidence'
          : advisory.confidence === 'MED'
            ? 'MED — confirm dual GO'
            : 'LOW — probe only',
    },
    {
      id: 'directive',
      label: 'Card stable',
      pass: dirGate.ok,
      detail: dirGate.reason ?? 'Directive held long enough',
    },
    {
      id: 'fresh',
      label: 'Not whipsawing',
      pass: !advisory.cautionFresh,
      detail: advisory.cautionFresh ? 'Fresh flip — wait 1–3s' : 'Stable',
    },
  ];

  if (takePlan) {
    checks.push({
      id: 'takePlan',
      label: 'Take signal',
      pass: takePlan.canTake,
      detail: takePlan.disabledReason ?? (takePlan.canTake ? 'Armed' : 'Not armed'),
    });
  }

  const readinessPct = readinessFromChecks(checks);
  const canTake = takePlan?.canTake === true;
  const stableReady =
    advisory.confidence !== 'LOW' && dirGate.ok && !advisory.cautionFresh && readinessPct >= 75;

  if (canTake) {
    const entry = fmtEntryCents(takePlan?.entry01);
    return {
      phase: 'ENTER_NOW',
      lane,
      headline: `ENTER ${name} NOW`,
      exactAction: entry
        ? `Enter now — take signal at ${entry}. Book desk is GO.`
        : `Enter now — take signal on ${name}.`,
      readinessPct: 100,
      confirmSecRemaining: null,
      checks,
      urgency: 'now',
      canExecute: true,
    };
  }

  if (stableReady) {
    return {
      phase: 'ALERT',
      lane,
      headline: `ALERT ${name}`,
      exactAction: `Setup live on ${name} — arm limit at ask; confirm dual GO before sizing up.`,
      readinessPct,
      confirmSecRemaining: null,
      checks,
      urgency: 'soon',
      canExecute: false,
    };
  }

  const blocker = checks.find((c) => !c.pass);
  return {
    phase: advisory.cautionFresh ? 'WAIT_SETUP' : 'ALERT',
    lane,
    headline: advisory.cautionFresh ? `WAIT — ${name}` : `ALERT ${name}`,
    exactAction: blocker?.detail ?? advisory.recommendation,
    readinessPct,
    confirmSecRemaining: null,
    checks,
    urgency: 'wait',
    canExecute: false,
  };
}

export function computeEntryMoment(input: EntryMomentInput): EntryMoment {
  const {
    advisory,
    execution,
    stability,
    directive,
    takePlan,
    machine,
    pressureTiming,
    upLabel,
    downLabel,
    bookOnly = false,
    contractLead,
  } = input;

  const pressure = pressureTiming ?? null;
  const lane = advisoryLane(advisory) ?? execution?.proposedLane ?? takePlan?.lane ?? null;
  const name = lane ? laneLabel(lane, upLabel, downLabel) : null;

  const emptyChecks: EntryMomentCheck[] = [
    {
      id: 'side',
      label: 'Side picked',
      pass: lane != null,
      detail: lane ? `BUY ${name}` : 'No clear UP/DOWN lean yet',
    },
  ];

  // --- Global blockers ---
  if (!advisory || advisory.verdict === 'NEITHER') {
    if (
      (pressure === 'EARLY' || pressure === 'BUILDING') &&
      contractLead?.phase === 'ENTER'
    ) {
      const leadLane = contractLeadLane(contractLead, upLabel, downLabel);
      if (leadLane) {
        const name = laneLabel(leadLane, upLabel, downLabel);
        const pressureLabel = pressure === 'EARLY' ? 'early 10s lead' : 'momentum building';
        return {
          phase: 'ENTER_NOW',
          lane: leadLane,
          headline: `${name} · 10s momentum live`,
          exactAction: `${contractLead.actionLine} Catch tape momentum — desk pick still neutral; size down until bias confirms.`,
          readinessPct: 70,
          confirmSecRemaining: 0,
          checks: [
            { id: 'side', label: 'Tape lane', pass: true, detail: `BUY ${name}` },
            { id: 'pressure', label: 'Inside momentum', pass: true, detail: pressureLabel },
            { id: 'bias', label: 'Desk pick', pass: false, detail: 'NEITHER — confirm settlement bias' },
            { id: 'lead', label: 'Contract lead', pass: true, detail: contractLead.actionLine },
          ],
          urgency: 'now',
          canExecute: true,
        };
      }
    }
    const chop = machine?.regime === 'chop';
    return {
      phase: chop ? 'NO_TRADE' : 'WAIT_SETUP',
      lane: null,
      headline: chop ? 'NO TRADE' : 'WAIT FOR SETUP',
      exactAction:
        advisory?.recommendation ??
        (chop ? 'Choppy regime — stand down until control clears.' : 'Wait for a clear BUY UP or BUY DOWN.'),
      readinessPct: advisory ? Math.min(35, advisory.confidencePct) : 0,
      confirmSecRemaining: null,
      checks: emptyChecks,
      urgency: chop ? 'stand_down' : 'wait',
      canExecute: false,
    };
  }

  if (stability?.whipsaw) {
    return {
      phase: 'WAIT_SETUP',
      lane,
      headline: 'WAIT — WHIPSAW',
      exactAction: 'Trade card flipping too fast — wait for directive to hold 2–3s before entry.',
      readinessPct: 15,
      confirmSecRemaining: null,
      checks: [
        ...emptyChecks,
        { id: 'whipsaw', label: 'Card stable', pass: false, detail: 'Whipsaw detected' },
      ],
      urgency: 'wait',
      canExecute: false,
    };
  }

  // --- Inside momentum (10s EARLY / BUILDING) — buy the move, not the 30s chase ---
  if ((pressure === 'EARLY' || pressure === 'BUILDING') && lane && advisory) {
    const leadEnter = contractLead?.phase === 'ENTER';
    const leadWatch = contractLead?.phase === 'WATCH';
    const aligned = advisoryLane(advisory) === lane;
    const lowOk = leadEnter || advisory.confidence !== 'LOW';
    if (aligned && lowOk && !advisory.cautionFresh) {
    const entry = fmtEntryCents(takePlan?.entry01 ?? advisory.mid);
    const pressureLabel = pressure === 'EARLY' ? 'early 10s lead' : 'momentum building';
    const momentumChecks: EntryMomentCheck[] = [
      ...emptyChecks,
      { id: 'pressure', label: 'Inside momentum', pass: true, detail: pressureLabel },
      {
        id: 'conviction',
        label: 'Conviction',
        pass: true,
        detail: `${advisory.confidence} · ${advisory.confidencePct}%`,
      },
      {
        id: 'lead',
        label: 'Contract lead',
        pass: leadEnter,
        detail: leadEnter ? contractLead!.actionLine : leadWatch ? 'Building — one more tick' : 'Watch 10s tape',
      },
    ];

    if (execution?.phase === 'ALERT') {
      const confirmRequired = execution.confirmRequiredMs ?? EXEC_CONFIRM_HOLD_MS;
      const confirmHeld = execution.confirmHeldMs ?? 0;
      const confirmSecRemaining = Math.max(0, Math.ceil((confirmRequired - confirmHeld) / 1000));
      const allButConfirm = execution.gates
        .filter((g) => g.id !== 'confirmHold')
        .every((g) => g.pass);
      if (allButConfirm && (leadEnter || advisory.confidencePct >= 62)) {
        const goNow = confirmSecRemaining <= 1 || (pressure === 'EARLY' && confirmSecRemaining <= 3);
        return {
          phase: goNow ? 'ENTER_NOW' : 'CONFIRMING',
          lane,
          headline: goNow ? `ENTER ${name} NOW` : `INSIDE MOMENTUM · ${name}`,
          exactAction: leadEnter
            ? `Buy inside momentum — ${contractLead!.actionLine}${goNow ? ' · pull trigger now.' : ` · ${confirmSecRemaining}s left on confirm — ride the move.`}`
            : `Buy inside ${pressureLabel} — limit ${name} at ${entry ?? 'ask'}. Don't wait for 30s confirm.`,
          readinessPct: Math.max(80, advisory.confidencePct - 4),
          confirmSecRemaining: goNow ? 0 : confirmSecRemaining,
          checks: momentumChecks,
          urgency: 'now',
          canExecute: goNow,
        };
      }
    }

    if (leadEnter) {
      return {
        phase: 'ENTER_NOW',
        lane,
        headline: `ENTER ${name} — inside momentum`,
        exactAction: entry
          ? `Buy inside the move at ${entry} — ${contractLead!.actionLine}. Take desk scalp or limit now; don't wait for 30s confirm.`
          : `Buy inside the move — ${contractLead!.actionLine}. Take desk scalp now.`,
        readinessPct: Math.min(96, advisory.confidencePct + 6),
        confirmSecRemaining: 0,
        checks: momentumChecks,
        urgency: 'now',
        canExecute: true,
      };
    }

    if (leadWatch || advisory.confidencePct >= 58) {
      return {
        phase: 'ALERT',
        lane,
        headline: `ALERT ${name} — ${pressureLabel}`,
        exactAction: leadWatch
          ? `${contractLead!.actionLine} Almost ready — enter on next tick inside momentum.`
          : `${advisory.recommendation} ${pressureLabel} live — prepare limit at ${entry ?? 'ask'}.`,
        readinessPct: Math.max(68, advisory.confidencePct - 6),
        confirmSecRemaining: null,
        checks: momentumChecks,
        urgency: 'soon',
        canExecute: false,
      };
    }
    }

    // Tape-led momentum when desk pick lags contract lead
    const leadLane = contractLead ? contractLeadLane(contractLead, upLabel, downLabel) : null;
    if (leadLane && !aligned && (leadEnter || leadWatch)) {
      const name = laneLabel(leadLane, upLabel, downLabel);
      const pressureLabel = pressure === 'EARLY' ? 'early 10s lead' : 'momentum building';
      const entry = fmtEntryCents(takePlan?.entry01 ?? advisory.mid);
      const momentumChecks: EntryMomentCheck[] = [
        { id: 'side', label: 'Tape lane', pass: true, detail: `BUY ${name}` },
        { id: 'pressure', label: 'Inside momentum', pass: true, detail: pressureLabel },
        { id: 'bias', label: 'Desk pick', pass: false, detail: `Waiting ${name} advisory confirm` },
        {
          id: 'lead',
          label: 'Contract lead',
          pass: leadEnter,
          detail: leadEnter ? contractLead!.actionLine : 'Building — one more tick',
        },
      ];
      if (leadEnter) {
        return {
          phase: 'ENTER_NOW',
          lane: leadLane,
          headline: `INSIDE MOMENTUM · ${name}`,
          exactAction: `${contractLead!.actionLine} Tape ahead of desk pick — catch on bid, confirm bias before full size.`,
          readinessPct: 74,
          confirmSecRemaining: 0,
          checks: momentumChecks,
          urgency: 'now',
          canExecute: true,
        };
      }
      return {
        phase: 'ALERT',
        lane: leadLane,
        headline: `ALERT ${name} — ${pressureLabel}`,
        exactAction: `${contractLead!.actionLine} Arm limit at ${entry ?? 'bid'} — bias confirm pending.`,
        readinessPct: 62,
        confirmSecRemaining: null,
        checks: momentumChecks,
        urgency: 'soon',
        canExecute: false,
      };
    }
  }

  if (pressure === 'CHASING' || pressure === 'EXTENDED') {
    const note =
      execution?.gates.find((g) => g.id === 'noSpike')?.detail ??
      (pressure === 'CHASING'
        ? 'Move already ran — do not chase the ask.'
        : 'Late for fresh entry — wait for next 10s lead or pullback.');
    const strongDeskEdge =
      lane &&
      advisoryLane(advisory) === lane &&
      !advisory.cautionFresh &&
      (advisory.confidence === 'HIGH' ||
        (advisory.confidence === 'MED' && advisory.confidencePct >= 62));
    if (strongDeskEdge) {
      return {
        phase: 'ALERT',
        lane,
        headline: `LEAN ${name}`,
        exactAction: `${note} Desk edge is live — join on bid or wait for EARLY pressure (<4pp on 10s); don't chase wide ask.`,
        readinessPct: Math.max(52, Math.min(78, advisory.confidencePct - 8)),
        confirmSecRemaining: null,
        checks: [
          ...emptyChecks,
          { id: 'pressure', label: 'Pressure timing', pass: false, detail: note },
        ],
        urgency: 'soon',
        canExecute: false,
      };
    }
    return {
      phase: 'WAIT_PULLBACK',
      lane,
      headline: 'WAIT FOR PULLBACK',
      exactAction: `${note} Re-enter when pressure is EARLY (<4pp on 10s).`,
      readinessPct: 25,
      confirmSecRemaining: null,
      checks: [
        ...emptyChecks,
        { id: 'pressure', label: 'Pressure timing', pass: false, detail: note },
      ],
      urgency: 'wait',
      canExecute: false,
    };
  }

  if (
    lane &&
    machine?.overextension?.state === 'overextended' &&
    machine.overextension.direction === lane
  ) {
    return {
      phase: 'WAIT_PULLBACK',
      lane,
      headline: `WAIT — ${name} EXTENDED`,
      exactAction: `Move overextended (×${machine.overextension.ratio.toFixed(1)}) — wait for dip or join on bid, not wide ask.`,
      readinessPct: 30,
      confirmSecRemaining: null,
      checks: [
        ...emptyChecks,
        {
          id: 'overextension',
          label: 'Not overextended',
          pass: false,
          detail: `×${machine.overextension.ratio.toFixed(1)} extension on ${name}`,
        },
      ],
      urgency: 'wait',
      canExecute: false,
    };
  }

  // --- Take signal is the operator truth on the main desk ---
  if (takePlan?.canTake && lane) {
    const entry = fmtEntryCents(takePlan.entry01);
    const execChecks = execution ? checksFromExecution(execution, lane, true) : emptyChecks;
    const dirGate = directiveAllowsTakeSignal(stability ?? null, directive ?? null);
    const checks: EntryMomentCheck[] = [
      { id: 'side', label: 'Side picked', pass: true, detail: `BUY ${name}` },
      { id: 'takePlan', label: 'Take signal armed', pass: true, detail: takePlan.buttonLabel },
      { id: 'directive', label: 'Card stable', pass: dirGate.ok, detail: dirGate.reason ?? 'OK' },
      ...execChecks.filter((c) => c.id !== 'side'),
    ];
    return {
      phase: 'ENTER_NOW',
      lane,
      headline: `ENTER ${name} NOW`,
      exactAction: entry
        ? `Enter now — click Take signal or limit buy ${name} at ${entry}. All gates passed.`
        : `Enter now — click Take signal on ${name}.`,
      readinessPct: 100,
      confirmSecRemaining: 0,
      checks,
      urgency: 'now',
      canExecute: true,
    };
  }

  if (bookOnly && lane) {
    return bookOnlyMoment({
      advisory,
      lane,
      stability,
      directive,
      takePlan,
      upLabel,
      downLabel,
    });
  }

  // --- Execution desk path ---
  if (execution) {
    const confirmRequired = execution.confirmRequiredMs ?? EXEC_CONFIRM_HOLD_MS;
    const confirmHeld = execution.confirmHeldMs ?? 0;
    const confirmSecRemaining = Math.max(0, Math.ceil((confirmRequired - confirmHeld) / 1000));
    const confirmPass = execution.phase === 'ENTER';
    const checks = checksFromExecution(execution, lane, confirmPass);

    if (execution.phase === 'NO_TRADE') {
      const reason = execution.summaryLine || execution.headline || 'Stand down';
      return {
        phase: 'NO_TRADE',
        lane: execution.proposedLane ?? lane,
        headline: 'NO TRADE',
        exactAction: reason,
        readinessPct: readinessFromChecks(checks),
        confirmSecRemaining: null,
        checks,
        urgency: 'stand_down',
        canExecute: false,
      };
    }

    if (execution.phase === 'ENTER' && lane) {
      const entry = fmtEntryCents(takePlan?.entry01 ?? advisory.mid);
      const laneMismatch = execution.proposedLane && execution.proposedLane !== lane;
      if (laneMismatch) {
        return {
          phase: 'ALERT',
          lane,
          headline: `ALERT — lane clash`,
          exactAction: `Execution ENTER on ${execution.proposedLane?.toUpperCase()} but advisory says ${name} — wait for alignment.`,
          readinessPct: 60,
          confirmSecRemaining: 0,
          checks,
          urgency: 'wait',
          canExecute: false,
        };
      }
      return {
        phase: 'ENTER_NOW',
        lane,
        headline: `ENTER ${name} NOW`,
        exactAction: entry
          ? `Enter now — execution desk confirmed. Limit buy ${name} at ${entry}.`
          : `Enter now — execution desk ENTER ${name}. Continuation confirmed after 7s hold.`,
        readinessPct: 100,
        confirmSecRemaining: 0,
        checks,
        urgency: 'now',
        canExecute: true,
      };
    }

    if (execution.phase === 'ALERT') {
      const allButConfirm = execution.gates
        .filter((g) => g.id !== 'confirmHold')
        .every((g) => g.pass);
      const phase: EntryMomentPhase = allButConfirm && confirmSecRemaining > 0 ? 'CONFIRMING' : 'ALERT';
      const blocker = execution.gates.find((g) => !g.pass);
      const exactAction =
        phase === 'CONFIRMING'
          ? confirmSecRemaining <= 2
            ? `Enter in ~${confirmSecRemaining}s — confirmation almost done. Keep limit ready at ask.`
            : `Hold ${confirmSecRemaining}s more — gates passed, building 7s continuation confirm. Do not chase yet.`
          : blocker
            ? `Setup on ${execution.proposedLane ? laneLabel(execution.proposedLane, upLabel, downLabel) : name ?? 'side'} — fix: ${blocker.detail}`
            : execution.summaryLine;

      const readinessPct =
        phase === 'CONFIRMING'
          ? Math.round(70 + (confirmHeld / Math.max(1, confirmRequired)) * 30)
          : readinessFromChecks(checks);

      return {
        phase,
        lane: execution.proposedLane ?? lane,
        headline:
          phase === 'CONFIRMING'
            ? `CONFIRMING ${name ?? execution.proposedLane?.toUpperCase() ?? ''} · ${confirmSecRemaining}s`
            : execution.headline,
        exactAction,
        readinessPct,
        confirmSecRemaining: phase === 'CONFIRMING' ? confirmSecRemaining : null,
        checks,
        urgency: phase === 'CONFIRMING' && confirmSecRemaining <= 3 ? 'soon' : 'wait',
        canExecute: false,
      };
    }

    // WAIT
    const blocker = execution.blockReasons[0] ?? execution.summaryLine ?? 'Base edge not ready';
    return {
      phase: 'WAIT_SETUP',
      lane,
      headline: 'WAIT FOR SETUP',
      exactAction: blocker,
      readinessPct: readinessFromChecks(checks),
      confirmSecRemaining: null,
      checks,
      urgency: 'wait',
      canExecute: false,
    };
  }

  // --- Advisory-only fallback (no execution yet) ---
  if (lane) {
    const dirGate = directiveAllowsTakeSignal(stability ?? null, directive ?? null);
    const checks: EntryMomentCheck[] = [
      { id: 'side', label: 'Side picked', pass: true, detail: `BUY ${name} · ${advisory.confidencePct}%` },
      {
        id: 'conviction',
        label: 'Conviction',
        pass: advisory.confidence !== 'LOW',
        detail: `${advisory.confidence} · mom ${advisory.momentumScore}`,
      },
      {
        id: 'fresh',
        label: 'Not whipsawing',
        pass: !advisory.cautionFresh,
        detail: advisory.cautionFresh ? 'Fresh — wait 1–3s' : 'Stable',
      },
      {
        id: 'directive',
        label: 'Card stable',
        pass: dirGate.ok,
        detail: dirGate.reason ?? 'OK',
      },
    ];
    const readinessPct = readinessFromChecks(checks);
    const readySoon = readinessPct >= 75 && !advisory.cautionFresh;

    return {
      phase: readySoon ? 'ALERT' : 'WAIT_SETUP',
      lane,
      headline: readySoon ? `ALERT ${name}` : `WAIT — ${name}`,
      exactAction: readySoon
        ? `Lean ${name} — ${advisory.recommendation} Wait for execution desk ENTER before sizing.`
        : checks.find((c) => !c.pass)?.detail ?? advisory.recommendation,
      readinessPct,
      confirmSecRemaining: null,
      checks,
      urgency: readySoon ? 'soon' : 'wait',
      canExecute: false,
    };
  }

  return {
    phase: 'WAIT_SETUP',
    lane: null,
    headline: 'WAIT FOR SETUP',
    exactAction: advisory.recommendation,
    readinessPct: advisory.confidencePct,
    confirmSecRemaining: null,
    checks: emptyChecks,
    urgency: 'wait',
    canExecute: false,
  };
}

/** Desk scalp may fire on ENTER_NOW, momentum window, or late CONFIRMING. */
export function entryMomentAllowsDeskScalp(
  moment: EntryMoment | null | undefined,
  opts?: {
    contractLead?: ContractLeadSignal | null;
    pressureTiming?: PressureTiming | null;
  },
): boolean {
  if (!moment) return true;
  if (moment.phase === 'ENTER_NOW') return true;
  if (moment.phase === 'CONFIRMING' && (moment.confirmSecRemaining ?? 99) <= 5) return true;
  const inMomentum =
    opts?.pressureTiming === 'EARLY' || opts?.pressureTiming === 'BUILDING';
  if (opts?.contractLead?.phase === 'ENTER' && inMomentum) return true;
  if (
    inMomentum &&
    (moment.phase === 'ALERT' || moment.phase === 'CONFIRMING') &&
    moment.readinessPct >= 68
  ) {
    return true;
  }
  return false;
}

export function entryMomentDeskScalpBlockReason(
  moment: EntryMoment | null | undefined,
  opts?: {
    contractLead?: ContractLeadSignal | null;
    pressureTiming?: PressureTiming | null;
  },
): string | null {
  if (!moment || entryMomentAllowsDeskScalp(moment, opts)) return null;
  return moment.exactAction;
}
