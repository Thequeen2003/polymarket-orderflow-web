/** Gamma often returns `clobTokenIds` as a JSON string; normalize for the web client. */

export function parseClobTokenIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return [];
    if (t.startsWith('[')) {
      try {
        const p = JSON.parse(t) as unknown;
        if (Array.isArray(p)) return p.map(String).filter(Boolean);
      } catch {
        /* fall through */
      }
    }
    return t
      .split(',')
      .map((s) => s.replace(/^["'\s]+|["'\s]+$/g, '').trim())
      .filter(Boolean);
  }
  return [];
}

export function normalizeMarket(m: unknown): unknown {
  if (!m || typeof m !== 'object') return m;
  const o = m as Record<string, unknown>;
  const ids = parseClobTokenIds(o.clobTokenIds ?? o.clob_token_ids);
  return { ...o, clob_token_ids: ids };
}

export function isGammaMarketShape(o: Record<string, unknown>): boolean {
  if (typeof o.conditionId === 'string' && o.conditionId.startsWith('0x')) return true;
  if (o.clobTokenIds != null || o.clob_token_ids != null) return true;
  if (
    typeof o.question === 'string' &&
    (typeof o.slug === 'string' || typeof o.id === 'string' || typeof o.id === 'number')
  )
    return true;
  const mk = o.markets;
  const hasNestedMarkets = Array.isArray(mk) && mk.length > 0;
  if (
    !hasNestedMarkets &&
    typeof o.slug === 'string' &&
    o.slug.trim() &&
    (typeof o.id === 'string' || typeof o.id === 'number')
  )
    return true;
  return false;
}

export function flattenSearchMarketRows(rows: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      out.push(row);
      continue;
    }
    const o = row as Record<string, unknown>;
    if (isGammaMarketShape(o)) {
      out.push(row);
      continue;
    }
    const mk = o.markets;
    if (Array.isArray(mk) && mk.length > 0) {
      const first = mk[0];
      const fo = first && typeof first === 'object' ? (first as Record<string, unknown>) : null;
      if (fo && isGammaMarketShape(fo)) {
        for (const m of mk) {
          if (m && typeof m === 'object') out.push(m);
        }
        continue;
      }
    }
    out.push(row);
  }
  return out;
}

export function dedupeSearchRows(rows: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') {
      out.push(r);
      continue;
    }
    const o = r as Record<string, unknown>;
    const id = o.id;
    const slug = o.slug;
    const key =
      typeof id === 'string' || typeof id === 'number'
        ? `id:${String(id)}`
        : typeof slug === 'string' && slug.trim()
          ? `slug:${slug.trim()}`
          : `anon:${seen.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
