export type TradeHistoryMode = 'paper' | 'live';
export type TradeHistorySide = 'buy' | 'sell';
export type TradeHistoryExec = 'touch' | 'market' | 'limit';

export type TradeHistoryRow = {
  id: string;
  ts: number;
  mode: TradeHistoryMode;
  exec: TradeHistoryExec;
  side: TradeHistorySide;
  token: string;
  label: string;
  /** For market orders: null if unknown, for limit/touch: price 0..1 */
  price01: number | null;
  shares: number | null;
  usdCents: number | null;
  /** 'filled' for paper, 'submitted' for live (we don't have fill events yet) */
  status: 'filled' | 'submitted' | 'error';
  error?: string;
};

const STORAGE_KEY = 'pmof.tradeHistory.v1';
const MAX_ROWS = 250;

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function loadTradeHistory(): TradeHistoryRow[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = safeJsonParse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[])
      .map((x) => x as Partial<TradeHistoryRow>)
      .filter((r) => r && typeof r === 'object')
      .map((r): TradeHistoryRow => ({
        id: String(r.id ?? ''),
        ts: typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : 0,
        mode: String(r.mode ?? '').toLowerCase() === 'live' ? 'live' : 'paper',
        exec: (() => {
          const v = String(r.exec ?? '').toLowerCase();
          return v === 'market' || v === 'limit' || v === 'touch' ? (v as TradeHistoryExec) : 'touch';
        })(),
        side: String(r.side ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy',
        token: String(r.token ?? ''),
        label: String(r.label ?? ''),
        price01: r.price01 == null ? null : Number.isFinite(Number(r.price01)) ? Number(r.price01) : null,
        shares: r.shares == null ? null : Number.isFinite(Number(r.shares)) ? Number(r.shares) : null,
        usdCents: r.usdCents == null ? null : Number.isFinite(Number(r.usdCents)) ? Number(r.usdCents) : null,
        status: (() => {
          const v = String(r.status ?? '').toLowerCase();
          return v === 'submitted' || v === 'error' || v === 'filled' ? (v as TradeHistoryRow['status']) : 'filled';
        })(),
        error: r.error != null ? String(r.error) : undefined,
      }))
      .filter((r) => r.id && r.ts > 0 && r.token)
      .slice(0, MAX_ROWS);
  } catch {
    return [];
  }
}

export function saveTradeHistory(rows: TradeHistoryRow[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows.slice(0, MAX_ROWS)));
  } catch {
    /* ignore */
  }
}

export function clearTradeHistory(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function randomId(): string {
  try {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    return `${a[0]!.toString(16)}${a[1]!.toString(16)}`;
  } catch {
    return String(Math.floor(Math.random() * 1e12));
  }
}

export function appendTradeHistory(row: Omit<TradeHistoryRow, 'id' | 'ts'> & { id?: string; ts?: number }): TradeHistoryRow[] {
  const next: TradeHistoryRow = {
    id: row.id ?? randomId(),
    ts: row.ts ?? Date.now(),
    mode: row.mode,
    exec: row.exec,
    side: row.side,
    token: row.token,
    label: row.label,
    price01: row.price01 ?? null,
    shares: row.shares ?? null,
    usdCents: row.usdCents ?? null,
    status: row.status,
    error: row.error,
  };
  const rows = loadTradeHistory();
  const merged = [next, ...rows].slice(0, MAX_ROWS);
  saveTradeHistory(merged);
  return merged;
}

export function appendTradeHistoryWithId(
  row: Omit<TradeHistoryRow, 'id' | 'ts'> & { id?: string; ts?: number },
): { id: string; rows: TradeHistoryRow[] } {
  const id = row.id ?? randomId();
  const rows = appendTradeHistory({ ...row, id });
  return { id, rows };
}

export function updateTradeHistoryRow(
  id: string,
  patch: Partial<Pick<TradeHistoryRow, 'status' | 'error' | 'price01' | 'shares' | 'usdCents'>>,
): TradeHistoryRow[] {
  const rows = loadTradeHistory();
  let changed = false;
  const next = rows.map((r) => {
    if (r.id !== id) return r;
    changed = true;
    return { ...r, ...patch };
  });
  if (changed) saveTradeHistory(next);
  return next;
}

function csvEscape(s: string): string {
  if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function tradeHistoryToCsv(rows: TradeHistoryRow[]): string {
  const header = [
    'ts',
    'time',
    'mode',
    'exec',
    'side',
    'label',
    'token',
    'price01',
    'price_cents',
    'shares',
    'usd_cents_abs',
    'status',
    'error',
  ];
  const lines: string[] = [];
  lines.push(header.join(','));
  for (const r of rows) {
    const priceCents = r.price01 == null ? '' : (r.price01 * 100).toFixed(2);
    lines.push(
      [
        String(r.ts),
        csvEscape(new Date(r.ts).toISOString()),
        csvEscape(r.mode),
        csvEscape(r.exec),
        csvEscape(r.side),
        csvEscape(r.label),
        csvEscape(r.token),
        r.price01 == null ? '' : String(r.price01),
        csvEscape(priceCents),
        r.shares == null ? '' : String(r.shares),
        r.usdCents == null ? '' : String(Math.abs(r.usdCents)),
        csvEscape(r.status),
        csvEscape(r.error ?? ''),
      ].join(','),
    );
  }
  return lines.join('\n');
}

