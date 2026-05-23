function normLabel(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function marketHintText(market: unknown | null): string {
  if (!market || typeof market !== 'object') return '';
  const o = market as Record<string, unknown>;
  const parts = [o.groupItemTitle, o.question, o.title, o.description].map((v) => (typeof v === 'string' ? v : ''));
  const slug = typeof o.slug === 'string' ? o.slug : '';
  return `${slug} ${parts.join(' ')}`.toLowerCase();
}

function marketSlugText(market: unknown | null): string {
  if (!market || typeof market !== 'object') return '';
  const slug = (market as Record<string, unknown>).slug;
  return typeof slug === 'string' ? slug.trim().toLowerCase() : '';
}

export function resolveUpDownIndices(
  labels: string[],
  market?: unknown | null,
): { up: number; down: number } | null {
  if (labels.length < 2) return null;
  // Many Polymarket markets have >2 outcomes. Most of this app is built around a 2-lane "up/down" view.
  // In those cases, default to the first two outcomes so the rest of the UI still functions.
  if (labels.length > 2) return { up: 0, down: 1 };
  const norm = labels.map(normLabel);
  const slug = marketSlugText(market ?? null);

  // Prefer explicit Up/Down or Above/Below style labels.
  const up = norm.findIndex((l) => l === 'up' || l.includes('above') || l.includes('higher'));
  const down = norm.findIndex((l) => l === 'down' || l.includes('below') || l.includes('lower'));
  if (up >= 0 && down >= 0 && up !== down) return { up, down };

  // If it's a Yes/No market, try to infer whether "Yes" corresponds to Above or Below from the question text.
  const hasYes = norm.some((l) => l === 'yes');
  const hasNo = norm.some((l) => l === 'no');
  if (hasYes && hasNo) {
    const yesIdx = norm.findIndex((l) => l === 'yes');
    const noIdx = norm.findIndex((l) => l === 'no');
    if (/-updown-(5m|15m|1h|4h|1d)-\d+/i.test(slug)) {
      return { up: yesIdx, down: noIdx };
    }
    const hint = marketHintText(market ?? null);
    // Typical structure: "Will <underlying> be above $X ... ?" => Yes == Above.
    if (hint.includes(' above ') || hint.includes(' higher ') || hint.includes(' exceed ') || hint.includes(' over ')) {
      return { up: yesIdx, down: noIdx };
    }
    if (hint.includes(' below ') || hint.includes(' lower ') || hint.includes(' under ') || hint.includes(' less than ')) {
      // Question framed as below/under => Yes corresponds to Below.
      return { up: noIdx, down: yesIdx };
    }
  }

  if (/-updown-(5m|15m|1h|4h|1d)-\d+/i.test(slug) && norm.length === 2) {
    const up2 = norm.findIndex((l) => l === 'up' || (/\bup\b/.test(l) && !/\bdown\b/.test(l)));
    const down2 = norm.findIndex((l) => l === 'down' || (/\bdown\b/.test(l) && !/\bup\b/.test(l)));
    if (up2 >= 0 && down2 >= 0 && up2 !== down2) return { up: up2, down: down2 };
  }

  // Last resort: preserve the book's native ordering.
  return { up: 0, down: 1 };
}

