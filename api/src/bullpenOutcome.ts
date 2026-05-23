/** Map UI / legacy labels to Bullpen CLI outcome names (Yes/No/Up/Down). */

import { parseClobTokenIds } from './polymarket/marketNormalize.js';
import { parseGammaOutcomeLabels, resolveUpDownIndices } from './upDown.js';

export function isCanonicalUpdownSlug(slug: string | null | undefined): boolean {
  return /-updown-(5m|15m|1h|4h|1d)-\d+/i.test((slug ?? '').trim());
}

/** Best-effort normalization from display text (e.g. "BTC Up" → "Up"). */
export function normalizeBullpenOutcomeName(outcome: string): string {
  const t = outcome.trim();
  if (!t) return t;
  const l = t.toLowerCase().replace(/\s+/g, ' ');
  const exact: Record<string, string> = {
    yes: 'Yes',
    no: 'No',
    up: 'Up',
    down: 'Down',
    y: 'Yes',
    n: 'No',
    true: 'Yes',
    false: 'No',
    '1': 'Yes',
    '0': 'No',
  };
  if (exact[l]) return exact[l]!;
  if (/\bup\b/.test(l) && !/\bdown\b/.test(l)) return 'Up';
  if (/\bdown\b/.test(l)) return 'Down';
  if (/\byes\b/.test(l)) return 'Yes';
  if (/\bno\b/.test(l) && !/\bnot\b/.test(l)) return 'No';
  return t;
}

export function resolveBullpenOutcome(args: {
  outcome: string;
  marketSlug?: string | null;
  lane?: 'up' | 'down' | null;
}): string {
  const raw = args.outcome.trim();
  if (!raw) return raw;
  const norm = normalizeBullpenOutcomeName(raw);
  if (!isCanonicalUpdownSlug(args.marketSlug)) return norm;
  const l = raw.toLowerCase();
  if (l === 'yes' || l === 'y' || l === 'true' || l === '1') return 'Up';
  if (l === 'no' || l === 'n' || l === 'false' || l === '0') return 'Down';
  if (args.lane === 'up') return 'Up';
  if (args.lane === 'down') return 'Down';
  if (norm === 'Yes' || norm === 'No') {
    return norm === 'No' ? 'Down' : 'Up';
  }
  return norm;
}

export function canonicalLaneToBullpenOutcome(lane: 'up' | 'down'): 'Up' | 'Down' {
  return lane === 'down' ? 'Down' : 'Up';
}

/** Which up/down lane owns this CLOB token for a Gamma market row. */
export function laneForTokenInMarket(
  market: Record<string, unknown>,
  tokenId: string,
): 'up' | 'down' | null {
  const tid = tokenId.trim();
  if (!tid) return null;
  const tokenIds = parseClobTokenIds(market.clobTokenIds ?? market.clob_token_ids);
  const idx = tokenIds.findIndex((t) => t === tid);
  if (idx < 0) return null;
  const labels = parseGammaOutcomeLabels(market);
  const ud = resolveUpDownIndices(labels, market);
  if (!ud) return null;
  if (idx === ud.up) return 'up';
  if (idx === ud.down) return 'down';
  return null;
}

export type ResolveBullpenOrderOutcomeResult =
  | { ok: true; outcome: string; tokenLane: 'up' | 'down' | null }
  | { ok: false; error: string; details?: Record<string, unknown> };

/**
 * Bullpen CLI uses market slug + outcome name (not token id). Resolve outcome from the
 * submitted token when possible so a stale UI tab cannot buy the opposite side.
 */
export function resolveBullpenOrderOutcome(args: {
  tokenId: string;
  marketSlug: string;
  lane?: 'up' | 'down' | null;
  outcomeHint?: string;
  market?: Record<string, unknown> | null;
}): ResolveBullpenOrderOutcomeResult {
  const tokenId = args.tokenId.trim();
  const marketSlug = args.marketSlug.trim();
  const lane = args.lane === 'up' || args.lane === 'down' ? args.lane : null;
  const hint = (args.outcomeHint ?? '').trim();

  let tokenLane: 'up' | 'down' | null = null;
  if (args.market && tokenId) {
    tokenLane = laneForTokenInMarket(args.market, tokenId);
  }

  if (tokenLane && lane && tokenLane !== lane) {
    return {
      ok: false,
      error: 'outcome_token_lane_mismatch',
      details: {
        hint: 'The outcome token does not match the requested up/down lane. Switch lane and retry.',
        tokenLane,
        lane,
      },
    };
  }

  const effectiveLane = tokenLane ?? lane;

  if (isCanonicalUpdownSlug(marketSlug) && effectiveLane) {
    return { ok: true, outcome: canonicalLaneToBullpenOutcome(effectiveLane), tokenLane };
  }

  if (tokenLane) {
    return { ok: true, outcome: canonicalLaneToBullpenOutcome(tokenLane), tokenLane };
  }

  if (!hint) {
    return {
      ok: false,
      error: 'missing_outcome',
      details: { hint: 'Send outcome label or a known token id with market_slug.' },
    };
  }

  return {
    ok: true,
    outcome: resolveBullpenOutcome({ outcome: hint, marketSlug, lane }),
    tokenLane,
  };
}
