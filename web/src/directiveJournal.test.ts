import { describe, expect, it } from 'vitest';
import {
  appendDirectiveToJournal,
  pruneJournal,
  resetJournal,
  journalToCsv,
  refreshJournalStats,
} from './directiveJournal';
import type { TradeDirective, DirectiveAction } from './tradeDirective';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';

function mkD(action: DirectiveAction, lane: 'up' | 'down' | null = 'up', edge: number | null = 0.1): TradeDirective {
  return {
    action,
    lane,
    urgency: 'soon',
    recommendedSize: 0.3,
    headline: action,
    reason: '',
    evidence: [],
    confidence: 'MED',
    defensive: false,
    edgePerShareUsd: edge,
    laneMid: 0.55,
    laneWinProb: 0.65,
  };
}

function mkR(agreement = 70): SpotPtbMachineReadout {
  return {
    agreementScore: agreement,
    focusLane: 'up',
    laneVotes: { up: 5, down: 1 },
    regime: 'trend',
    urgency: 'med',
    probVsSpot: 'aligned',
    crossProb: 0.3,
    crossEstimate: null,
    acceleration: null,
    mtf: null,
    overextension: null,
    endingProb: null,
    edges: null,
    sensors: {
      spotVsPtb: 'up',
      impliedLeader: 'up',
      sectionalDrift: 'up',
      bookControl: 'up',
      microSlope: 'up',
      dwellBias: 'up',
      accel: 'idle',
      mtfDominant: null,
      overextended: null,
    },
    lines: [],
  };
}

describe('directiveJournal', () => {
  it('starts empty', () => {
    const j = resetJournal();
    expect(j.entries).toHaveLength(0);
    expect(j.stats.total).toBe(0);
  });

  it('appends the first directive', () => {
    const j = appendDirectiveToJournal(null, mkD('INITIATE', 'up'), mkR(75), 1000);
    expect(j.entries).toHaveLength(1);
    expect(j.entries[0]?.action).toBe('INITIATE');
    expect(j.entries[0]?.agreementScore).toBe(75);
    expect(j.stats.total).toBe(1);
    expect(j.stats.byAction.INITIATE).toBe(1);
  });

  it('skips duplicates (same action + lane)', () => {
    let j = appendDirectiveToJournal(null, mkD('INITIATE', 'up'), mkR(), 1000);
    j = appendDirectiveToJournal(j, mkD('INITIATE', 'up'), mkR(), 2000);
    j = appendDirectiveToJournal(j, mkD('INITIATE', 'up'), mkR(), 3000);
    expect(j.entries).toHaveLength(1);
  });

  it('appends on lane change', () => {
    let j = appendDirectiveToJournal(null, mkD('INITIATE', 'up'), mkR(), 1000);
    j = appendDirectiveToJournal(j, mkD('INITIATE', 'down'), mkR(), 2000);
    expect(j.entries).toHaveLength(2);
    expect(j.entries[1]?.lane).toBe('down');
  });

  it('appends on action change', () => {
    let j = appendDirectiveToJournal(null, mkD('INITIATE', 'up'), mkR(), 0);
    j = appendDirectiveToJournal(j, mkD('HOLD', 'up'), mkR(), 5000);
    j = appendDirectiveToJournal(j, mkD('TRIM', 'up'), mkR(), 10000);
    expect(j.entries).toHaveLength(3);
    expect(j.stats.byAction.INITIATE).toBe(1);
    expect(j.stats.byAction.HOLD).toBe(1);
    expect(j.stats.byAction.TRIM).toBe(1);
  });

  it('caps entries at 50', () => {
    let j = appendDirectiveToJournal(null, mkD('INITIATE', 'up'), mkR(), 0);
    for (let i = 1; i <= 60; i++) {
      const action: DirectiveAction = i % 2 === 0 ? 'HOLD' : 'TRIM';
      j = appendDirectiveToJournal(j, mkD(action, 'up'), mkR(), i * 1000);
    }
    expect(j.entries.length).toBeLessThanOrEqual(50);
  });

  it('computes average agreement and edge', () => {
    let j = appendDirectiveToJournal(null, mkD('INITIATE', 'up', 0.1), mkR(70), 0);
    j = appendDirectiveToJournal(j, mkD('HOLD', 'up', 0.2), mkR(80), 5000);
    j = appendDirectiveToJournal(j, mkD('TRIM', 'up', 0.05), mkR(60), 10000);
    expect(j.stats.averageAgreement).toBeCloseTo(70, 5);
    expect(j.stats.averageEdgeUsd).toBeCloseTo(0.1166, 3);
  });

  it('computes flips per minute', () => {
    let j = appendDirectiveToJournal(null, mkD('INITIATE', 'up'), mkR(), 0);
    j = appendDirectiveToJournal(j, mkD('HOLD', 'up'), mkR(), 30_000);
    j = appendDirectiveToJournal(j, mkD('FLIP', 'down'), mkR(), 60_000);
    expect(j.stats.flipsPerMin).toBeGreaterThan(2);
  });

  it('pruneJournal drops old entries', () => {
    let j = appendDirectiveToJournal(null, mkD('INITIATE', 'up'), mkR(), 0);
    j = appendDirectiveToJournal(j, mkD('HOLD', 'up'), mkR(), 60_000);
    j = appendDirectiveToJournal(j, mkD('TRIM', 'up'), mkR(), 120_000);
    const pruned = pruneJournal(j, 130_000, 30_000);
    expect(pruned.entries.length).toBeLessThan(j.entries.length);
    expect(pruned.entries.every((e) => e.ts >= 100_000)).toBe(true);
  });

  it('handles null readout gracefully', () => {
    const j = appendDirectiveToJournal(null, mkD('INITIATE', 'up'), null, 1000);
    expect(j.entries).toHaveLength(1);
    expect(j.entries[0]?.agreementScore).toBeNull();
    expect(j.stats.averageAgreement).toBeNull();
  });

  it('refreshJournalStats recomputes stats for the same entries', () => {
    let j = appendDirectiveToJournal(null, mkD('INITIATE', 'up'), mkR(), 0);
    j = appendDirectiveToJournal(j, mkD('HOLD', 'up'), mkR(), 60_000);
    const stale = { ...j, stats: { ...j.stats, total: 999, flipsPerMin: 0, windowMinutes: 0 } };
    const fixed = refreshJournalStats(stale, 120_000);
    expect(fixed.stats.total).toBe(2);
    expect(fixed.stats.flipsPerMin).toBeGreaterThan(0);
    expect(fixed.entries).toHaveLength(2);
  });
});

describe('journalToCsv', () => {
  it('emits header only on empty journal', () => {
    const csv = journalToCsv(null);
    expect(csv.split('\n')).toHaveLength(1);
    expect(csv).toMatch(/^ts_iso,ts_ms,slug,action,lane/);
  });

  it('emits one row per entry with slug column populated', () => {
    let j = appendDirectiveToJournal(null, mkD('INITIATE', 'up', 0.1), mkR(70), 1_700_000_000_000);
    j = appendDirectiveToJournal(j, mkD('TRIM', 'up', 0.05), mkR(60), 1_700_000_010_000);
    const csv = journalToCsv(j, 'btc-1h-up-down');
    const rows = csv.split('\n');
    expect(rows).toHaveLength(3); // header + 2
    expect(rows[1]).toContain('btc-1h-up-down');
    expect(rows[1]).toContain('INITIATE');
    expect(rows[2]).toContain('TRIM');
  });

  it('escapes the headline with JSON.stringify so commas survive', () => {
    const j = appendDirectiveToJournal(
      null,
      { ...mkD('INITIATE', 'up'), headline: 'GO IN, UP' },
      mkR(),
      0,
    );
    const csv = journalToCsv(j, '');
    expect(csv).toContain('"GO IN, UP"');
  });
});
