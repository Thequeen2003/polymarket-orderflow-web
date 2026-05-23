/**
 * Decision journal for the trade-directive engine.
 *
 * Records every *meaningful* directive change (action and/or lane different from
 * the previous entry), capped at a fixed ring buffer. The UI renders this as a
 * compact rolling log so the user can review the system's recent calls and
 * spot patterns (e.g., the directive flip-flopped 4 times around a key level,
 * or held INITIATE UP for two minutes before exiting cleanly).
 *
 * It also computes lightweight aggregate stats:
 *   - count by action verb
 *   - average agreement at change-time
 *   - average edge per share at change-time
 *   - total flips per minute (over the captured window)
 *
 * Pure module — no React, no globals.
 */

import type { TradeDirective, DirectiveAction, DirectiveUrgency } from './tradeDirective';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';

const MAX_ENTRIES = 50;

export type JournalEntry = {
  ts: number;
  action: DirectiveAction;
  lane: 'up' | 'down' | null;
  urgency: DirectiveUrgency;
  recommendedSize: number;
  /** Edge per share at change-time (null if not actionable). */
  edgePerShareUsd: number | null;
  /** Agreement score at change-time (null if no readout). */
  agreementScore: number | null;
  headline: string;
};

export type JournalStats = {
  total: number;
  byAction: Partial<Record<DirectiveAction, number>>;
  averageAgreement: number | null;
  averageEdgeUsd: number | null;
  flipsPerMin: number;
  windowMinutes: number;
};

export type DirectiveJournal = {
  entries: JournalEntry[];
  stats: JournalStats;
};

const EMPTY_STATS: JournalStats = {
  total: 0,
  byAction: {},
  averageAgreement: null,
  averageEdgeUsd: null,
  flipsPerMin: 0,
  windowMinutes: 0,
};

const EMPTY: DirectiveJournal = { entries: [], stats: EMPTY_STATS };

function entryKey(e: { action: DirectiveAction; lane: 'up' | 'down' | null }): string {
  return `${e.action}|${e.lane ?? '-'}`;
}

function buildStats(entries: JournalEntry[], nowMs: number): JournalStats {
  if (entries.length === 0) return EMPTY_STATS;

  const byAction: Partial<Record<DirectiveAction, number>> = {};
  let agreementSum = 0;
  let agreementCount = 0;
  let edgeSum = 0;
  let edgeCount = 0;
  for (const e of entries) {
    byAction[e.action] = (byAction[e.action] ?? 0) + 1;
    if (e.agreementScore != null) {
      agreementSum += e.agreementScore;
      agreementCount += 1;
    }
    if (e.edgePerShareUsd != null) {
      edgeSum += e.edgePerShareUsd;
      edgeCount += 1;
    }
  }

  const earliestTs = entries[0]!.ts;
  const windowMs = Math.max(1, nowMs - earliestTs);
  const windowMinutes = windowMs / 60_000;
  const flipsPerMin = entries.length / windowMinutes;

  return {
    total: entries.length,
    byAction,
    averageAgreement: agreementCount > 0 ? agreementSum / agreementCount : null,
    averageEdgeUsd: edgeCount > 0 ? edgeSum / edgeCount : null,
    flipsPerMin,
    windowMinutes,
  };
}

/** Recompute aggregate stats for a journal (e.g. after loading from localStorage). */
export function refreshJournalStats(journal: DirectiveJournal | null, nowMs: number): DirectiveJournal {
  const j = journal ?? EMPTY;
  return {
    entries: j.entries,
    stats: buildStats(j.entries, nowMs),
  };
}

/**
 * Append a new directive to the journal *if* it differs from the last logged
 * entry. Returns the new journal — caller stores it in state/ref.
 */
export function appendDirectiveToJournal(
  prev: DirectiveJournal | null,
  directive: TradeDirective | null,
  readout: SpotPtbMachineReadout | null,
  nowMs: number,
): DirectiveJournal {
  const base = prev ?? EMPTY;
  if (!directive) return base;

  const last = base.entries[base.entries.length - 1] ?? null;
  if (last && entryKey(last) === entryKey({ action: directive.action, lane: directive.lane })) {
    // Same call — don't spam the log.
    return base;
  }

  const entry: JournalEntry = {
    ts: nowMs,
    action: directive.action,
    lane: directive.lane,
    urgency: directive.urgency,
    recommendedSize: directive.recommendedSize,
    edgePerShareUsd: directive.edgePerShareUsd,
    agreementScore: readout?.agreementScore ?? null,
    headline: directive.headline,
  };

  const entries = [...base.entries, entry].slice(-MAX_ENTRIES);
  return {
    entries,
    stats: buildStats(entries, nowMs),
  };
}

/**
 * Drop entries older than `maxAgeMs` and recompute stats. Caller decides when
 * to prune (e.g., new round → start a fresh journal entirely, or call this
 * each minute to keep the rolling window tight).
 */
export function pruneJournal(
  prev: DirectiveJournal | null,
  nowMs: number,
  maxAgeMs: number,
): DirectiveJournal {
  if (!prev || prev.entries.length === 0) return prev ?? EMPTY;
  const cutoff = nowMs - maxAgeMs;
  const entries = prev.entries.filter((e) => e.ts >= cutoff);
  if (entries.length === prev.entries.length) return prev;
  return { entries, stats: buildStats(entries, nowMs) };
}

/** Reset the journal — call on slug/round change. */
export function resetJournal(): DirectiveJournal {
  return EMPTY;
}

/**
 * Render the journal as a CSV string. Header row + one row per entry. Caller
 * is responsible for prompting the download in the browser; we keep this pure
 * so it can be unit-tested.
 */
export function journalToCsv(journal: DirectiveJournal | null, slug?: string | null): string {
  const cols = [
    'ts_iso',
    'ts_ms',
    'slug',
    'action',
    'lane',
    'urgency',
    'recommended_size',
    'edge_per_share_usd',
    'agreement_score',
    'headline',
  ];
  const rows: string[] = [cols.join(',')];
  if (!journal) return rows.join('\n');
  for (const e of journal.entries) {
    const cells = [
      new Date(e.ts).toISOString(),
      String(e.ts),
      slug ?? '',
      e.action,
      e.lane ?? '',
      e.urgency,
      e.recommendedSize.toFixed(4),
      e.edgePerShareUsd != null ? e.edgePerShareUsd.toFixed(4) : '',
      e.agreementScore != null ? e.agreementScore.toFixed(2) : '',
      JSON.stringify(e.headline ?? ''),
    ];
    rows.push(cells.join(','));
  }
  return rows.join('\n');
}

/** Trigger a browser download for the journal CSV. Safe to call in non-DOM tests (no-ops). */
export function downloadJournalCsv(journal: DirectiveJournal | null, slug?: string | null): boolean {
  if (typeof document === 'undefined') return false;
  const csv = journalToCsv(journal, slug);
  try {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `directive-journal_${slug ?? 'round'}_${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    return true;
  } catch {
    return false;
  }
}
