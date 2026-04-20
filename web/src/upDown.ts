function normLabel(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function marketHintText(market: unknown | null): string {
  if (!market || typeof market !== 'object') return '';
  const o = market as Record<string, unknown>;
  const parts = [o.groupItemTitle, o.question, o.title, o.description].map((v) => (typeof v === 'string' ? v : ''));
  return parts.join(' ').toLowerCase();
}

export function resolveUpDownIndices(
  labels: string[],
  market?: unknown | null,
): { up: number; down: number } | null {
  if (labels.length !== 2) return null;
  const norm = labels.map(normLabel);

  // Prefer explicit Up/Down or Above/Below style labels.
  const up = norm.findIndex((l) => l === 'up' || l.includes('above') || l.includes('higher'));
  const down = norm.findIndex((l) => l === 'down' || l.includes('below') || l.includes('lower'));
  if (up >= 0 && down >= 0 && up !== down) return { up, down };

  // If it's a Yes/No market, try to infer whether "Yes" corresponds to Above or Below from the question text.
  const hasYes = norm.some((l) => l === 'yes');
  const hasNo = norm.some((l) => l === 'no');
  if (hasYes && hasNo) {
    const hint = marketHintText(market ?? null);
    const yesIdx = norm.findIndex((l) => l === 'yes');
    const noIdx = norm.findIndex((l) => l === 'no');
    // Typical structure: "Will <underlying> be above $X ... ?" => Yes == Above.
    if (hint.includes(' above ') || hint.includes(' higher ') || hint.includes(' exceed ') || hint.includes(' over ')) {
      return { up: yesIdx, down: noIdx };
    }
    if (hint.includes(' below ') || hint.includes(' lower ') || hint.includes(' under ') || hint.includes(' less than ')) {
      // Question framed as below/under => Yes corresponds to Below.
      return { up: noIdx, down: yesIdx };
    }
  }

  // Last resort: preserve the book's native ordering.
  return { up: 0, down: 1 };
}

