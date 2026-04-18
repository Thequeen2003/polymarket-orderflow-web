export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; error: string; details?: unknown; raw?: string };

async function getJson<T>(path: string): Promise<ApiOk<T> | ApiErr> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!res.ok) return (parsed as ApiErr) ?? { ok: false, error: `http_${res.status}` };
    return parsed as ApiOk<T>;
  } catch {
    return { ok: false, error: `bad_json_http_${res.status}`, raw: text.slice(0, 4000) };
  }
}

export function health() {
  return getJson<{ polymarket: string | null; note: string }>('/api/health');
}

export function marketsList(limit = 20) {
  return getJson<unknown[]>(`/api/markets?limit=${encodeURIComponent(String(limit))}`);
}

export function marketsSearch(q: string, limit = 20) {
  return getJson<unknown[]>(`/api/markets/search?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(String(limit))}`);
}

export function marketsGet(slugOrId: string) {
  return getJson<unknown>(`/api/markets/get/${encodeURIComponent(slugOrId)}`);
}

export function clobBook(tokenId: string) {
  return getJson<unknown>(`/api/clob/book/${encodeURIComponent(tokenId)}`);
}

export type ClobBookEntry = { token: string; book: unknown; error: string | null };

export function clobBooks(tokenIds: string[]) {
  const q = tokenIds.join(',');
  return getJson<ClobBookEntry[]>(`/api/clob/books?tokens=${encodeURIComponent(q)}`);
}

