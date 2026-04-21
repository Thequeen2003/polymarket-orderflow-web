import type { Net4cEstimate } from './executionEstimator';
import type { PtbNet4cRoomLabel } from './ptbNet4cTradeability';
import type { SystemVerdict } from './ptbDecisionEngine';

export type PtbDualSample = {
  id: string;
  t: number;
  slug: string;
  verdict: SystemVerdict;
  gateArmed: boolean;
  room: PtbNet4cRoomLabel;
  net4cOk: boolean;
  wallClearanceCents: number | null;
  outcome30s?: { t: number; ok: boolean; profitCents: number | null } | null;
  outcome2m?: { t: number; ok: boolean; profitCents: number | null } | null;
};

const LS = 'pm-ptb-dual-playbook-v1';

export function loadPtbDualSamples(): PtbDualSample[] {
  try {
    const raw = localStorage.getItem(LS);
    if (!raw) return [];
    const p = JSON.parse(raw) as unknown;
    return Array.isArray(p) ? (p as PtbDualSample[]) : [];
  } catch {
    return [];
  }
}

export function savePtbDualSamples(samples: PtbDualSample[]) {
  try {
    localStorage.setItem(LS, JSON.stringify(samples.slice(0, 1500)));
  } catch {
    /* ignore */
  }
}

export function appendPtbDualSample(sample: PtbDualSample) {
  const cur = loadPtbDualSamples();
  savePtbDualSamples([sample, ...cur]);
}

export function updatePtbDualSampleById(id: string, patch: Partial<PtbDualSample>) {
  const cur = loadPtbDualSamples();
  const ix = cur.findIndex((s) => s.id === id);
  if (ix < 0) return;
  cur[ix] = { ...cur[ix]!, ...patch };
  savePtbDualSamples(cur);
}

export function sampleFromPtbEvent(params: {
  slug: string;
  verdict: SystemVerdict;
  gateArmed: boolean;
  room: PtbNet4cRoomLabel;
  net4c: Net4cEstimate;
  wallClearanceCents: number | null;
}): PtbDualSample {
  return {
    id: `ptbd-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    t: Date.now(),
    slug: params.slug,
    verdict: params.verdict,
    gateArmed: params.gateArmed,
    room: params.room,
    net4cOk: params.net4c.ok,
    wallClearanceCents: params.wallClearanceCents,
  };
}

export function summarizePtbDual(samples: PtbDualSample[]): {
  n: number;
  armedOrEnter: number;
  hit4cRate: number | null;
} {
  const n = samples.length;
  if (n === 0) return { n: 0, armedOrEnter: 0, hit4cRate: null };
  const interesting = samples.filter((s) => s.gateArmed || s.verdict === 'ENTER' || s.verdict === 'SCALP');
  const with30 = interesting.filter((s) => s.outcome30s != null);
  const okHits = with30.filter((s) => s.outcome30s!.ok).length;
  return {
    n,
    armedOrEnter: interesting.length,
    hit4cRate: with30.length ? okHits / with30.length : null,
  };
}
