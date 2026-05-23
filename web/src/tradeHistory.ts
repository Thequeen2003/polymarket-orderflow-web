export type TradeHistoryMode = 'paper' | 'live';
export type TradeHistorySide = 'buy' | 'sell';
export type TradeHistoryExec = 'touch' | 'market' | 'limit' | 'settlement';

/** Live order lifecycle; legacy rows may still read `submitted` / `error` until re-saved. */
export type TradeHistoryOrderStatus =
  | 'sending'
  | 'pending'
  | 'sent'
  | 'partial'
  | 'filled'
  | 'failed'
  | 'no_fill'
  | 'cancelled'
  /** @deprecated use `sent` */
  | 'submitted'
  /** @deprecated use `failed` */
  | 'error';

export type TradeHistoryRow = {
  id: string;
  ts: number;
  mode: TradeHistoryMode;
  exec: TradeHistoryExec;
  side: TradeHistorySide;
  token: string;
  label: string;
  /** Gamma / routing slug when known — used by global positions dashboard. */
  marketSlug?: string;
  /** Market question / title when known. */
  marketTitle?: string;
  /**
   * Legacy combined price — prefer `fillAvgPrice01` / `submittedPrice01` / `quotedPrice01`.
   * Kept for CSV export and older UI; reconciler sets this to fill avg when known.
   */
  price01: number | null;
  /** Touch / limit quote or mid at intent time (what the UI showed). */
  quotedPrice01?: number | null;
  /** The price the user chose/clicked (pre-submit intent). */
  intendedPrice01?: number | null;
  /** Exact limit or cross price sent to the CLOB (after tick rounding). */
  submittedPrice01?: number | null;
  /** Volume-weighted average fill when filled or partially filled. */
  fillAvgPrice01?: number | null;
  /** Book or chart mid at click (mark), for slippage context. */
  markPrice01?: number | null;
  /**
   * Filled shares so far.
   * - For `filled`: equals the final filled shares.
   * - For `partial`: the amount filled so far.
   * - For `sent` / `sending`: may be the requested size (legacy optimistic rows) or null.
   */
  shares: number | null;
  /** Requested / submitted shares (original order size), when known. */
  requestedShares?: number | null;
  /** Remaining shares to fill (requested - filled), when known. */
  remainingShares?: number | null;
  usdCents: number | null;
  status: TradeHistoryOrderStatus;
  /** Client ↔ API round trip (ms), when measured. */
  roundTripMs?: number | null;
  /** CLOB order id when resting limit / touch order is placed. */
  orderId?: string | null;
  /** Optional mismatch or reconciliation note for support / debugging. */
  auditNote?: string;
  error?: string;
};

const STORAGE_KEY = 'pmof.tradeHistory.v2';
const LEGACY_STORAGE_KEY = 'pmof.tradeHistory.v1';
export const TRADE_HISTORY_MAX_ROWS = 250;
const MAX_ROWS = TRADE_HISTORY_MAX_ROWS;

/** Fired after local trade history storage changes (any writer). */
export const TRADE_HISTORY_CHANGED_EVENT = 'pmof:trade-history-changed';

function notifyTradeHistoryChanged(): void {
  try {
    // Defer so writers never synchronously re-enter other components' setState during a
    // React render/update (e.g. `setHistoryRows(prev => updateTradeHistoryRow(...))` in
    // SignalsTradePanel would otherwise fire TrackingTab listeners mid-commit).
    queueMicrotask(() => {
      try {
        window.dispatchEvent(new Event(TRADE_HISTORY_CHANGED_EVENT));
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function migrateStatus(v: string): TradeHistoryOrderStatus {
  const s = v.toLowerCase();
  if (s === 'sending' || s === 'pending' || s === 'sent' || s === 'partial' || s === 'filled' || s === 'failed' || s === 'no_fill' || s === 'cancelled') {
    return s as TradeHistoryOrderStatus;
  }
  if (s === 'submitted') return 'sent';
  if (s === 'error') return 'failed';
  return 'filled';
}

function rowFromPartial(r: Partial<TradeHistoryRow>): TradeHistoryRow {
  const status = migrateStatus(String(r.status ?? 'filled'));
  const price01 = r.price01 == null ? null : Number.isFinite(Number(r.price01)) ? Number(r.price01) : null;
  const quotedPrice01 =
    r.quotedPrice01 == null ? null : Number.isFinite(Number(r.quotedPrice01)) ? Number(r.quotedPrice01) : null;
  const intendedPrice01 =
    r.intendedPrice01 == null ? null : Number.isFinite(Number(r.intendedPrice01)) ? Number(r.intendedPrice01) : null;
  const submittedPrice01 =
    r.submittedPrice01 == null ? null : Number.isFinite(Number(r.submittedPrice01)) ? Number(r.submittedPrice01) : null;
  const fillAvgPrice01 =
    r.fillAvgPrice01 == null ? null : Number.isFinite(Number(r.fillAvgPrice01)) ? Number(r.fillAvgPrice01) : null;
  const markPrice01 = r.markPrice01 == null ? null : Number.isFinite(Number(r.markPrice01)) ? Number(r.markPrice01) : null;
  const roundTripMs =
    r.roundTripMs == null ? null : Number.isFinite(Number(r.roundTripMs)) ? Number(r.roundTripMs) : null;
  const orderId = r.orderId != null && String(r.orderId).trim() ? String(r.orderId).trim() : null;
  const shares = r.shares == null ? null : Number.isFinite(Number(r.shares)) ? Number(r.shares) : null;
  const requestedShares =
    r.requestedShares == null ? null : Number.isFinite(Number(r.requestedShares)) ? Number(r.requestedShares) : null;
  const remainingShares =
    r.remainingShares == null ? null : Number.isFinite(Number(r.remainingShares)) ? Number(r.remainingShares) : null;
  return {
    id: String(r.id ?? ''),
    ts: typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : 0,
    mode: String(r.mode ?? '').toLowerCase() === 'live' ? 'live' : 'paper',
    exec: (() => {
      const v = String(r.exec ?? '').toLowerCase();
      return v === 'market' || v === 'limit' || v === 'touch' || v === 'settlement' ? (v as TradeHistoryExec) : 'touch';
    })(),
    side: String(r.side ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy',
    token: String(r.token ?? ''),
    label: String(r.label ?? ''),
    marketSlug: r.marketSlug != null && String(r.marketSlug).trim() ? String(r.marketSlug).trim() : undefined,
    marketTitle: r.marketTitle != null && String(r.marketTitle).trim() ? String(r.marketTitle).trim() : undefined,
    price01,
    // Never backfill quoted/submitted/fill from legacy `price01` for LIVE rows — that caused incorrect prices
    // when `price01` was a “best guess” (e.g. mid / estimate) rather than an execution price.
    // Paper rows can still fall back for older persisted history.
    quotedPrice01: quotedPrice01 ?? (status === 'filled' && String(r.mode ?? '').toLowerCase() !== 'live' ? price01 : null),
    intendedPrice01: intendedPrice01 ?? null,
    submittedPrice01:
      submittedPrice01 ?? ((status === 'sent' || status === 'filled' || status === 'partial') && String(r.mode ?? '').toLowerCase() !== 'live' ? price01 : null),
    fillAvgPrice01: fillAvgPrice01 ?? ((status === 'filled' || status === 'partial') && String(r.mode ?? '').toLowerCase() !== 'live' ? price01 : null),
    markPrice01: markPrice01 ?? null,
    shares,
    requestedShares: requestedShares ?? null,
    remainingShares: remainingShares ?? null,
    usdCents: r.usdCents == null ? null : Number.isFinite(Number(r.usdCents)) ? Number(r.usdCents) : null,
    status,
    roundTripMs,
    orderId,
    auditNote: r.auditNote != null ? String(r.auditNote) : undefined,
    error: r.error != null ? String(r.error) : undefined,
  };
}

export function loadTradeHistory(): TradeHistoryRow[] {
  try {
    let raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) {
        try {
          window.localStorage.setItem(STORAGE_KEY, raw);
        } catch {
          /* ignore */
        }
      }
    }
    if (!raw) return [];
    const parsed = safeJsonParse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[])
      .map((x) => x as Partial<TradeHistoryRow>)
      .filter((r) => r && typeof r === 'object')
      .map((r) => rowFromPartial(r))
      .filter((r) => r.id && r.ts > 0 && r.token)
      .slice(0, MAX_ROWS);
  } catch {
    return [];
  }
}

export function saveTradeHistory(rows: TradeHistoryRow[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows.slice(0, MAX_ROWS)));
    notifyTradeHistoryChanged();
  } catch {
    /* ignore */
  }
}

export function clearTradeHistory(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    notifyTradeHistoryChanged();
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
    marketSlug: row.marketSlug,
    marketTitle: row.marketTitle,
    price01: row.price01 ?? null,
    quotedPrice01: row.quotedPrice01 ?? null,
    intendedPrice01: row.intendedPrice01 ?? null,
    submittedPrice01: row.submittedPrice01 ?? null,
    fillAvgPrice01: row.fillAvgPrice01 ?? null,
    markPrice01: row.markPrice01 ?? null,
    shares: row.shares ?? null,
    requestedShares: row.requestedShares ?? null,
    remainingShares: row.remainingShares ?? null,
    usdCents: row.usdCents ?? null,
    status: row.status,
    roundTripMs: row.roundTripMs ?? null,
    orderId: row.orderId ?? null,
    auditNote: row.auditNote,
    error: row.error,
  };
  const tailA = loadTradeHistory();
  const tailB = loadTradeHistory();
  const tail =
    tailB.length !== tailA.length || (tailB[0] && tailA[0] && tailB[0].id !== tailA[0].id) ? tailB : tailA;
  const merged = [next, ...tail].slice(0, MAX_ROWS);
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
  patch: Partial<
    Pick<
      TradeHistoryRow,
      | 'status'
      | 'error'
      | 'price01'
      | 'shares'
      | 'requestedShares'
      | 'remainingShares'
      | 'usdCents'
      | 'quotedPrice01'
      | 'intendedPrice01'
      | 'submittedPrice01'
      | 'fillAvgPrice01'
      | 'markPrice01'
      | 'roundTripMs'
      | 'orderId'
      | 'auditNote'
    >
  >,
): TradeHistoryRow[] {
  const rid = String(id ?? '').trim();
  if (!rid) return loadTradeHistory();
  /** Re-read immediately before write so a concurrent `appendTradeHistory` isn’t overwritten. */
  const latest = loadTradeHistory();
  const j = latest.findIndex((r) => r.id === rid);
  if (j < 0) return latest;
  const next = [...latest];
  next[j] = { ...latest[j]!, ...patch };
  saveTradeHistory(next.slice(0, MAX_ROWS));
  return next;
}

export function deleteTradeHistoryRow(id: string): TradeHistoryRow[] {
  const rid = String(id ?? '').trim();
  if (!rid) return loadTradeHistory();
  const rows = loadTradeHistory();
  const next = rows.filter((r) => r.id !== rid);
  if (next.length !== rows.length) saveTradeHistory(next);
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
    'market_slug',
    'market_title',
    'token',
    'quoted_price01',
    'intended_price01',
    'submitted_price01',
    'fill_avg_price01',
    'mark_price01',
    'price01_legacy',
    'price_cents_legacy',
    'shares',
    'requested_shares',
    'remaining_shares',
    'usd_cents_abs',
    'status',
    'round_trip_ms',
    'order_id',
    'audit_note',
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
        csvEscape(r.marketSlug ?? ''),
        csvEscape(r.marketTitle ?? ''),
        csvEscape(r.token),
        r.quotedPrice01 == null ? '' : String(r.quotedPrice01),
        r.intendedPrice01 == null ? '' : String(r.intendedPrice01),
        r.submittedPrice01 == null ? '' : String(r.submittedPrice01),
        r.fillAvgPrice01 == null ? '' : String(r.fillAvgPrice01),
        r.markPrice01 == null ? '' : String(r.markPrice01),
        r.price01 == null ? '' : String(r.price01),
        csvEscape(priceCents),
        r.shares == null ? '' : String(r.shares),
        r.requestedShares == null ? '' : String(r.requestedShares),
        r.remainingShares == null ? '' : String(r.remainingShares),
        r.usdCents == null ? '' : String(Math.abs(r.usdCents)),
        csvEscape(r.status),
        r.roundTripMs == null ? '' : String(r.roundTripMs),
        csvEscape(r.orderId ?? ''),
        csvEscape(r.auditNote ?? ''),
        csvEscape(r.error ?? ''),
      ].join(','),
    );
  }
  return lines.join('\n');
}

