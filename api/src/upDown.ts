/** Match web/src/upDown.ts — map Gamma outcome rows to up/down lanes. */

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

export function parseGammaOutcomeLabels(market: Record<string, unknown>): string[] {
  const raw = market.outcomes;
  if (Array.isArray(raw)) {
    return raw.map((o) => {
      if (typeof o === 'string') return o;
      if (o && typeof o === 'object') {
        const r = o as Record<string, unknown>;
        return String(r.title ?? r.name ?? 'Outcome');
      }
      return 'Outcome';
    });
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return [];
    if (t.startsWith('[')) {
      try {
        const p = JSON.parse(t) as unknown;
        if (Array.isArray(p)) return p.map((x) => String(x));
      } catch {
        /* ignore */
      }
    }
    return t.split(',').map((s) => s.replace(/^["'\s]+|["'\s]+$/g, '').trim()).filter(Boolean);
  }
  return [];
}

export function resolveUpDownIndices(
  labels: string[],
  market?: unknown | null,
): { up: number; down: number } | null {
  if (labels.length < 2) return null;
  if (labels.length > 2) return { up: 0, down: 1 };
  const norm = labels.map(normLabel);
  const slug = marketSlugText(market ?? null);

  const up = norm.findIndex((l) => l === 'up' || l.includes('above') || l.includes('higher'));
  const down = norm.findIndex((l) => l === 'down' || l.includes('below') || l.includes('lower'));
  if (up >= 0 && down >= 0 && up !== down) return { up, down };

  const hasYes = norm.some((l) => l === 'yes');
  const hasNo = norm.some((l) => l === 'no');
  if (hasYes && hasNo) {
    const yesIdx = norm.findIndex((l) => l === 'yes');
    const noIdx = norm.findIndex((l) => l === 'no');
    if (/-updown-(5m|15m|1h|4h|1d)-\d+/i.test(slug)) {
      return { up: yesIdx, down: noIdx };
    }
    const hint = marketHintText(market ?? null);
    if (hint.includes(' above ') || hint.includes(' higher ') || hint.includes(' exceed ') || hint.includes(' over ')) {
      return { up: yesIdx, down: noIdx };
    }
    if (hint.includes(' below ') || hint.includes(' lower ') || hint.includes(' under ') || hint.includes(' less than ')) {
      return { up: noIdx, down: yesIdx };
    }
  }

  if (/-updown-(5m|15m|1h|4h|1d)-\d+/i.test(slug) && norm.length === 2) {
    const up2 = norm.findIndex((l) => l === 'up' || (/\bup\b/.test(l) && !/\bdown\b/.test(l)));
    const down2 = norm.findIndex((l) => l === 'down' || (/\bdown\b/.test(l) && !/\bup\b/.test(l)));
    if (up2 >= 0 && down2 >= 0 && up2 !== down2) return { up: up2, down: down2 };
  }

  return { up: 0, down: 1 };
}
