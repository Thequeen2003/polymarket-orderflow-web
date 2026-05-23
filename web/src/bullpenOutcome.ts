/** Client-side Bullpen outcome labels (keep in sync with api/src/bullpenOutcome.ts). */

export function isCanonicalUpdownSlug(slug: string | null | undefined): boolean {
  return /-updown-(5m|15m|1h|4h|1d)-\d+/i.test((slug ?? '').trim());
}

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

/** Authoritative Bullpen outcome for canonical updown slugs — do not pass decorative labels. */
export function canonicalLaneToBullpenOutcome(lane: 'up' | 'down'): 'Up' | 'Down' {
  return lane === 'down' ? 'Down' : 'Up';
}

export function bullpenOutcomeForOrder(args: {
  lane: 'up' | 'down';
  marketSlug?: string | null;
  label?: string;
}): string {
  if (isCanonicalUpdownSlug(args.marketSlug)) {
    return canonicalLaneToBullpenOutcome(args.lane);
  }
  return resolveBullpenOutcome({
    outcome: args.label ?? (args.lane === 'down' ? 'Down' : 'Up'),
    marketSlug: args.marketSlug,
    lane: args.lane,
  });
}
