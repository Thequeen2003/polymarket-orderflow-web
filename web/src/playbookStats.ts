import type { AlertKind, ScalpVerdictState } from './momentumAlertsTypes';
import type { Net4cEstimate } from './executionEstimator';

export type PlaybookSample = {
  id: string;
  t: number;
  slug: string;
  kind: AlertKind;
  confidenceScore?: number;
  spreadCents?: number | null;
  churn?: number | null;
  /** Scalp verdict at sample time (if computed). */
  verdict?: ScalpVerdictState;
  /** Follow-up net+4¢ check ~30s after sample (READY scalps). */
  outcome30s?: { t: number; ok: boolean; profitCents: number | null } | null;
  /** Follow-up net+4¢ check ~2m after sample. */
  outcome2m?: { t: number; ok: boolean; profitCents: number | null } | null;
  /** Reference-size net +4¢ estimate at sample time. */
  net4c: {
    ok: boolean;
    profitCents: number | null;
    requiredGrossCents: number | null;
    flags: string[];
  };
};

export type PlaybookStats = {
  n: number;
  okRate: number;
  avgProfitCents: number | null;
};

const LS = 'pm-playbook-stats-v1';

export function loadSamples(): PlaybookSample[] {
  try {
    const raw = localStorage.getItem(LS);
    if (!raw) return [];
    const p = JSON.parse(raw) as unknown;
    return Array.isArray(p) ? (p as PlaybookSample[]) : [];
  } catch {
    return [];
  }
}

export function saveSamples(samples: PlaybookSample[]) {
  try {
    localStorage.setItem(LS, JSON.stringify(samples.slice(0, 2000)));
  } catch {
    /* ignore */
  }
}

export function appendSample(sample: PlaybookSample) {
  const cur = loadSamples();
  saveSamples([sample, ...cur]);
}

export function updateSampleById(id: string, patch: Partial<PlaybookSample>) {
  const cur = loadSamples();
  const ix = cur.findIndex((s) => s.id === id);
  if (ix < 0) return;
  cur[ix] = { ...cur[ix]!, ...patch };
  saveSamples(cur);
}

export function sampleFromNet4c(params: {
  slug: string;
  kind: AlertKind;
  confidenceScore?: number;
  spreadCents?: number | null;
  churn?: number | null;
  verdict?: ScalpVerdictState;
  net4c: Net4cEstimate;
}): PlaybookSample {
  return {
    id: `pbs-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    t: Date.now(),
    slug: params.slug,
    kind: params.kind,
    confidenceScore: params.confidenceScore,
    spreadCents: params.spreadCents,
    churn: params.churn,
    verdict: params.verdict,
    net4c: {
      ok: params.net4c.ok,
      profitCents: params.net4c.net.profitCents,
      requiredGrossCents: params.net4c.net.requiredGrossCents,
      flags: params.net4c.flags,
    },
  };
}

export function bucketSpread(spreadCents: number | null | undefined): string {
  if (spreadCents == null || !Number.isFinite(spreadCents)) return '—';
  if (spreadCents <= 2) return '≤2¢';
  if (spreadCents <= 4) return '2–4¢';
  if (spreadCents <= 7) return '4–7¢';
  return '≥7¢';
}

export function bucketConfidence(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return '—';
  if (score >= 80) return '80–100';
  if (score >= 55) return '55–79';
  return '0–54';
}

export function computeStats(samples: PlaybookSample[]): PlaybookStats {
  const n = samples.length;
  if (n === 0) return { n: 0, okRate: 0, avgProfitCents: null };
  const okN = samples.filter((s) => s.net4c.ok).length;
  const profits = samples.map((s) => s.net4c.profitCents).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  const avgProfitCents = profits.length ? profits.reduce((a, b) => a + b, 0) / profits.length : null;
  return { n, okRate: okN / n, avgProfitCents };
}

