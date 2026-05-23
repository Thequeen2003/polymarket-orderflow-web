/**
 * Infer resolved outcomes from Gamma-style market rows so the practice wallet can redeem like Polymarket ($1/sh winner, $0 loser).
 */

import { pickConditionId } from './bookIntel';

export type PaperSettlementPlan = {
  marketKey: string;
  winners: { tokenId: string; label: string }[];
  losers: { tokenId: string; label: string }[];
};

function pickTokenIds(market: unknown): string[] {
  if (!market || typeof market !== 'object') return [];
  const anyMarket = market as Record<string, unknown>;
  const ids = anyMarket.clob_token_ids ?? anyMarket.clobTokenIds;
  if (Array.isArray(ids)) return ids.map(String).filter(Boolean);
  if (typeof ids === 'string') {
    const t = ids.trim();
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t) as unknown;
        if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
      } catch {
        /* fall through */
      }
    }
    return t.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function pickOutcomeLabels(market: unknown): string[] {
  if (!market || typeof market !== 'object') return [];
  const m = market as Record<string, unknown>;
  const raw = m.outcomes;
  if (Array.isArray(raw)) {
    return raw.map((o) => {
      if (typeof o === 'string') return o;
      if (o && typeof o === 'object') return String((o as Record<string, unknown>).title ?? (o as Record<string, unknown>).name ?? 'Outcome');
      return 'Outcome';
    });
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.map((x) => String(x));
    } catch {
      /* ignore */
    }
  }
  return [];
}

function parseNumLoose(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Gamma `outcomePrices` may be a JSON string or array; values are 0..1 (or occasionally percent-like). */
export function parseGammaOutcomePrices(market: unknown): number[] | null {
  if (!market || typeof market !== 'object') return null;
  const o = market as Record<string, unknown>;
  const raw = o.outcomePrices ?? o.outcome_prices ?? o.outcomePrice;
  const asNums = (arr: unknown[]): number[] | null => {
    const nums = arr.map(parseNumLoose);
    if (nums.some((x) => x == null)) return null;
    return nums as number[];
  };
  if (Array.isArray(raw)) return asNums(raw);
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    try {
      const p = JSON.parse(s) as unknown;
      if (Array.isArray(p)) return asNums(p);
    } catch {
      /* ignore */
    }
  }
  return null;
}

function normalizeProbPrice(p: number): number {
  if (!Number.isFinite(p)) return NaN;
  if (p > 1 && p <= 100) return p / 100;
  return p;
}

export function inferPaperGammaSettlement(market: unknown | null, slugFallback: string): PaperSettlementPlan | null {
  if (!market || typeof market !== 'object') return null;
  const m = market as Record<string, unknown>;
  if (m.closed !== true) return null;

  const tokens = pickTokenIds(market);
  const labels = pickOutcomeLabels(market);
  const rawPrices = parseGammaOutcomePrices(market);

  if (!tokens.length || tokens.length !== labels.length) return null;
  if (!rawPrices || rawPrices.length !== tokens.length) return null;

  const winners: PaperSettlementPlan['winners'] = [];
  const losers: PaperSettlementPlan['losers'] = [];

  for (let i = 0; i < tokens.length; i++) {
    const p0 = normalizeProbPrice(rawPrices[i]!);
    if (!Number.isFinite(p0)) return null;
    const tid = String(tokens[i] ?? '').trim();
    const lab = String(labels[i] ?? `Outcome ${i + 1}`).slice(0, 160);
    if (!tid) return null;

    if (p0 >= 0.99) winners.push({ tokenId: tid, label: lab });
    else if (p0 <= 0.02) losers.push({ tokenId: tid, label: lab });
    else return null;
  }

  if (winners.length === 0) return null;
  if (winners.length + losers.length !== tokens.length) return null;

  const cid = pickConditionId(market);
  const slug =
    typeof m.slug === 'string' && m.slug.trim()
      ? m.slug.trim()
      : typeof slugFallback === 'string'
        ? slugFallback.trim()
        : '';
  const marketKey = cid ? `cond:${cid}` : slug ? `slug:${slug}` : '';
  if (!marketKey) return null;

  return { marketKey, winners, losers };
}

/** Short UI line when Gamma shows a resolved binary-ish market (Practice mode banner). */
export function paperSettlementCaption(market: unknown | null): string | null {
  const slug =
    market && typeof market === 'object' ? String((market as Record<string, unknown>).slug ?? '').trim() : '';
  const plan = inferPaperGammaSettlement(market, slug);
  if (!plan) return null;
  const w = plan.winners.map((x) => x.label).join(' · ');
  return `Winning side${plan.winners.length > 1 ? 's' : ''}: ${w}. Practice fills redeem @ $1/share on those tokens (losers → $0).`;
}
