import { describe, expect, it, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { appendDirectiveToJournal, resetJournal } from './directiveJournal';
import type { TradeDirective } from './tradeDirective';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import {
  clearAllSignalsDeskHolds,
  clearSignalsDeskPersist,
  loadAutoTradeSizeShares,
  loadSignalsDeskPersist,
  readSignalsDeskBoot,
  saveAutoTradeSizeShares,
  saveSignalsDeskPersist,
} from './signalsPagePersist';

const mem = new Map<string, string>();
const mockLocalStorage = {
  getItem(k: string) {
    return mem.has(k) ? mem.get(k)! : null;
  },
  setItem(k: string, v: string) {
    mem.set(k, v);
  },
  removeItem(k: string) {
    mem.delete(k);
  },
  clear() {
    mem.clear();
  },
  key(i: number) {
    const keys = [...mem.keys()];
    return keys[i] ?? null;
  },
  get length() {
    return mem.size;
  },
} as Storage;

function mkD(): TradeDirective {
  return {
    action: 'INITIATE',
    lane: 'up',
    urgency: 'soon',
    recommendedSize: 0.25,
    headline: 'Test',
    reason: '',
    evidence: [],
    confidence: 'MED',
    defensive: false,
    edgePerShareUsd: 0.05,
    laneMid: 0.5,
    laneWinProb: 0.55,
  };
}

function mkR(): SpotPtbMachineReadout {
  return {
    agreementScore: 72,
    focusLane: 'up',
    laneVotes: { up: 4, down: 2 },
    regime: 'chop',
    urgency: 'low',
    probVsSpot: 'aligned',
    crossProb: 0.2,
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

describe('signalsPagePersist', () => {
  const slug = 'test-btc-updown-signals';

  beforeAll(() => {
    vi.stubGlobal('localStorage', mockLocalStorage);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    mem.clear();
  });

  it('roundtrips ack + journal', () => {
    const journal = appendDirectiveToJournal(null, mkD(), mkR(), 10_000);
    saveSignalsDeskPersist(slug, {
      manualPositionLane: 'down',
      signalTakenAtMs: 99_000,
      signalTakenMid01: 0.42,
      journal,
    });
    const got = loadSignalsDeskPersist(slug);
    expect(got?.manualPositionLane).toBe('down');
    expect(got?.signalTakenAtMs).toBe(99_000);
    expect(got?.signalTakenMid01).toBe(0.42);
    expect(got?.journal.entries).toHaveLength(1);
    expect(got?.journal.entries[0]?.action).toBe('INITIATE');
  });

  it('loads legacy v1 JSON without signalTakenMid01 (mid stays null)', () => {
    const journal = resetJournal();
    mem.set(
      'pm_signals_desk_v1:' + encodeURIComponent(slug),
      JSON.stringify({
        v: 1,
        savedAt: Date.now(),
        manualPositionLane: 'up',
        signalTakenAtMs: 12_000,
        journal,
      }),
    );
    const got = loadSignalsDeskPersist(slug);
    expect(got?.signalTakenMid01).toBeNull();
    expect(got?.manualPositionLane).toBe('up');
  });

  it('readSignalsDeskBoot returns empty when nothing stored', () => {
    const b = readSignalsDeskBoot(slug);
    expect(b.manualPositionLane).toBeNull();
    expect(b.signalTakenAtMs).toBeNull();
    expect(b.signalTakenMid01).toBeNull();
    expect(b.journal.entries).toHaveLength(0);
  });

  it('rejects corrupt JSON', () => {
    mem.set('pm_signals_desk_v1:' + encodeURIComponent(slug), '{not json');
    expect(loadSignalsDeskPersist(slug)).toBeNull();
  });

  it('rejects wrong schema', () => {
    mem.set(
      'pm_signals_desk_v1:' + encodeURIComponent(slug),
      JSON.stringify({ v: 1, savedAt: 1, manualPositionLane: 'sideways', signalTakenAtMs: null, journal: resetJournal() }),
    );
    expect(loadSignalsDeskPersist(slug)).toBeNull();
  });

  it('clearSignalsDeskPersist removes key', () => {
    saveSignalsDeskPersist(slug, {
      manualPositionLane: 'up',
      signalTakenAtMs: 1,
      signalTakenMid01: 0.88,
      journal: resetJournal(),
    });
    expect(loadSignalsDeskPersist(slug)).not.toBeNull();
    clearSignalsDeskPersist(slug);
    expect(loadSignalsDeskPersist(slug)).toBeNull();
  });

  it('clearAllSignalsDeskHolds clears hold tags but keeps journal', () => {
    const journal = appendDirectiveToJournal(null, mkD(), mkR(), 1);
    saveSignalsDeskPersist('market-a', {
      manualPositionLane: 'up',
      signalTakenAtMs: 1,
      signalTakenMid01: 0.5,
      journal,
    });
    saveSignalsDeskPersist('market-b', {
      manualPositionLane: 'down',
      signalTakenAtMs: 2,
      signalTakenMid01: 0.4,
      journal,
    });
    expect(clearAllSignalsDeskHolds()).toBe(2);
    expect(loadSignalsDeskPersist('market-a')?.manualPositionLane).toBeNull();
    expect(loadSignalsDeskPersist('market-b')?.manualPositionLane).toBeNull();
    expect(loadSignalsDeskPersist('market-a')?.journal.entries.length).toBeGreaterThan(0);
  });

  it('readSignalsDeskBoot clears hold ack when last save is stale (no ghost I-hold-Up)', () => {
    const journal = appendDirectiveToJournal(null, mkD(), mkR(), 1);
    const staleAt = Date.now() - 5 * 60 * 60 * 1000;
    mem.set(
      'pm_signals_desk_v1:' + encodeURIComponent(slug),
      JSON.stringify({
        v: 1,
        savedAt: staleAt,
        manualPositionLane: 'up',
        signalTakenAtMs: staleAt,
        signalTakenMid01: 0.95,
        journal,
      }),
    );
    const b = readSignalsDeskBoot(slug);
    expect(b.manualPositionLane).toBeNull();
    expect(b.signalTakenAtMs).toBeNull();
    expect(b.signalTakenMid01).toBeNull();
    expect(b.journal.entries.length).toBeGreaterThan(0);
  });

  it('persists auto-trade share size', () => {
    saveAutoTradeSizeShares(25.5);
    expect(loadAutoTradeSizeShares()).toBe(25.5);
  });
});
