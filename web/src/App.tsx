import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  assistantChat,
  clobBooks,
  health,
  marketsGet,
  marketsList,
  marketsSearch,
  marketsUpdownShortcut,
  type ApiErr,
  type ApiOk,
  type ClobBookEntry,
  type UpdownInterval,
  type UpdownShortcutAsset,
} from './lib/api';
import { BookSideGrouped } from './BookPanel';
import { displayPrice, midPrice, pickBookLevels, topOfBook } from './bookLevels';
import { MomentumChart, type SeriesPoint } from './MomentumChart';
import { resolveUpDownIndices } from './upDown';
import { OrderFlowChart } from './OrderFlowChart';
import { snapshotFromBook, type BookSnapshot } from './orderflowMetrics';
import { MomentumAlertsTab } from './MomentumAlertsTab';
import { AboveBelowDashboard } from './AboveBelowDashboard';
import { FlowZonesTab } from './FlowZonesTab';
import { SignalsPtbOnly } from './SignalsPtbOnly';
import { SignalsTradePanel } from './SignalsTradePanel';
import { TradeSegmentedControl } from './tradeUi';
import { PtbWatchTab } from './PtbWatchTab';
import { priceToBeat, rtdsCrypto, type RtdsCryptoPoint } from './lib/api';
import { WorkspaceTab } from './WorkspaceTab';
import { DualPtbReferenceTab } from './DualPtbReferenceTab';
import { TradeSlidePanel } from './TradeSlidePanel';
import { PositionsCommandPanel } from './PositionsCommandPanel';
import { TradeHistoryTab } from './TradeHistoryTab';
import { shortTradeTabLabel, TradeSessionTabsBar, type TradeSessionTab } from './TradeSessionTabsBar';
import { PtbMultiAssetGrid, type PtbMultiAssetRow } from './PtbMultiAssetGrid';
import { UnifiedPtbView } from './UnifiedPtbView';
import { TrackingTab } from './TrackingTab';
import { PtbThreeUp } from './PtbThreeUp';
import { MultiMarketCommandView, type MarketKey, type MultiMarketRow } from './MultiMarketCommandView';
import { SmartMoneyPaperPanel } from './SmartMoneyPaperPanel';
import { STREAM_ATTRIBUTION_LINE } from './streamAttribution';
import { PolySimulatorTradePanel } from './PolySimulatorTradePanel';
import type { SpotPoint } from './SpotLevelChart';
import { openClobMarketChannel } from './clobMarketChannel';
import {
  bookIntelForAssistant,
  bookIntelLines,
  computeBookIntel,
  formatGammaVolumeLines,
  pickGammaVolumeStats,
} from './bookIntel';
import { outcomeEntryExitHints } from './chartReadouts';
import { buildRollingContext, rollingContextText } from './contextSummary';
import { nextUpdownSlug, parseUpdownSlug } from './sixPackUpdownSlugs';

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function apiReachabilityHint(err: ApiErr): string {
  if (err.error !== 'fetch_failed') return '';
  const d = err.details != null ? String(err.details) : '';
  return (
    '\n\nCould not reach the backend. Typical fixes:\n' +
    '• From repo root: npm run dev (starts API :8787 + Vite; markets use the /api proxy).\n' +
    '• Or: npm run dev -w api in one terminal, npm run dev -w web in another.\n' +
    '• vite preview / static dist: create web/.env with VITE_API_BASE=http://127.0.0.1:8787, rebuild, and keep the API running.\n' +
    (d ? `Details: ${d}\n` : '')
  );
}

const PTB_WATCH_SLUGS_KEY = 'ptbWatchSlugs.v1';
const PTB_WATCH_RECENT_KEY = 'ptbWatchRecentSlugs.v1';
const PTB_THREE_UP_INTERVAL_KEY = 'ptbThreeUpInterval.v1';

function readStringArray(key: string, max: number): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out = parsed.map((x) => String(x).trim()).filter(Boolean);
    return out.slice(0, max);
  } catch {
    return [];
  }
}

function writeStringArray(key: string, value: string[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function isOk<T>(res: ApiOk<T> | ApiErr): res is ApiOk<T> {
  return (res as ApiOk<T>).ok === true && 'data' in (res as ApiOk<T>);
}

/** API should return an array; coerce wrapped shapes so the list never `.map`s a non-array. */
function asMarketRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    for (const key of ['markets', 'data', 'items', 'results'] as const) {
      const inner = o[key];
      if (Array.isArray(inner)) return inner;
    }
  }
  return [];
}

/** True when this object is a Gamma market row (not an event wrapper). */
function isGammaMarketRow(m: unknown): boolean {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
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

function pickMarketSlug(m: unknown): string {
  if (!m || typeof m !== 'object') return '';
  const o = m as Record<string, unknown>;
  if (!isGammaMarketRow(m)) {
    const mk = o.markets;
    if (Array.isArray(mk) && mk.length > 0) {
      const first = mk[0];
      if (first && isGammaMarketRow(first)) {
        return pickMarketSlug(first);
      }
    }
  }
  if (typeof o.slug === 'string' && o.slug.trim()) return o.slug.trim();
  if (typeof o.market_slug === 'string' && o.market_slug.trim()) return o.market_slug.trim();
  if (typeof o.id === 'string' && o.id.trim()) return o.id.trim();
  if (typeof o.id === 'number' && Number.isFinite(o.id)) return String(o.id);
  return '';
}

function shortToken(id: string) {
  if (id.length <= 24) return id;
  return `${id.slice(0, 12)}…${id.slice(-8)}`;
}

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

/** Match server: accept slug/id or full `polymarket.com/event/...` URLs when pasting from the site. */
function normalizeMarketLookupRef(raw: string): string {
  const s = decodeURIComponent(raw).trim();
  if (!s) return '';
  if (!/polymarket\.com/i.test(s)) return s;
  try {
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const u = new URL(withProto);
    const parts = u.pathname.split('/').filter(Boolean);
    const keyIdx = parts.findIndex((p) => /^(event|events|market|markets)$/i.test(p));
    if (keyIdx !== -1 && parts[keyIdx + 1]) return decodeURIComponent(parts[keyIdx + 1]!);
    const last = parts[parts.length - 1];
    return last ? decodeURIComponent(last) : s;
  } catch {
    return s;
  }
}

function pickMarketQuestion(m: unknown): string {
  if (!m || typeof m !== 'object') return '';
  const o = m as Record<string, unknown>;
  return String(o.question ?? o.title ?? '').trim();
}

function isMarketClosed(m: unknown | null): boolean {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  return o.closed === true;
}

function mergeSpotHistory(
  prev: SpotPoint[],
  data: { value: number; ts: number; history?: RtdsCryptoPoint[] },
): SpotPoint[] {
  const serverTs = Number.isFinite(data.ts) ? data.ts : Date.now();
  const hist = data.history;
  const cleaned =
    Array.isArray(hist) && hist.length > 0
      ? hist
          .filter((q) => typeof q.t === 'number' && typeof q.v === 'number' && Number.isFinite(q.t) && Number.isFinite(q.v))
          .sort((a, b) => a.t - b.t)
          .slice(-600)
      : null;
  if (cleaned != null && cleaned.length > 0) return cleaned;
  return [...prev, { t: serverTs, v: data.value }].slice(-600);
}

function isShortcutAsset(asset: string): asset is UpdownShortcutAsset {
  return asset === 'btc' || asset === 'eth' || asset === 'sol';
}

function buildAssistantContext(
  slug: string,
  market: unknown | null,
  books: ClobBookEntry[] | null,
  labels: string[],
): string {
  const lines: string[] = [];
  lines.push(`Market slug: ${slug || '—'}`);
  const q = pickMarketQuestion(market);
  if (q) lines.push(`Question: ${q.slice(0, 800)}`);
  const gv = pickGammaVolumeStats(market);
  const gLines = formatGammaVolumeLines(gv);
  lines.push('');
  lines.push('--- Gamma (venue / slow stats — not live tape) ---');
  for (const gl of gLines) lines.push(gl);
  if (books) {
    for (let i = 0; i < books.length; i++) {
      const e = books[i]!;
      const lab = labels[i] ?? `Outcome ${i + 1}`;
      lines.push('');
      lines.push(`[${lab}] token ${shortToken(e.token)}`);
      if (e.error) lines.push(`  book error: ${e.error}`);
      else {
        const { asks, bids } = pickBookLevels(e.book);
        const askStr = asks.slice(0, 10).map((l) => `${l.price}×${l.size}`).join(', ');
        const bidStr = bids.slice(0, 10).map((l) => `${l.price}×${l.size}`).join(', ');
        lines.push(`  asks (buyable, sample): ${askStr || '—'}`);
        lines.push(`  bids (sellable, sample): ${bidStr || '—'}`);
        lines.push(bookIntelForAssistant(lab, e.book));
      }
    }
  }
  return lines.join('\n');
}

type AutoLine = { ts: number; kind: 'sent' | 'reply' | 'error'; text: string };

function AutoTerminal({ lines }: { lines: AutoLine[] }): ReactElement {
  const tail = lines.slice(-12);
  return (
    <div className="mt-4 rounded-2xl border border-zinc-800/50 bg-black/20 p-3 ring-1 ring-white/[0.02]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Auto context feed</div>
        <div className="text-[10px] text-zinc-600">{lines.length === 0 ? 'idle' : `${lines.length} lines`}</div>
      </div>
      <div className="max-h-40 overflow-y-auto rounded-xl border border-zinc-800/40 bg-black/25 p-2 font-mono text-[11px] leading-relaxed text-zinc-300">
        {tail.length === 0 ? (
          <div className="text-zinc-600">No updates yet.</div>
        ) : (
          tail.map((l, i) => (
            <div key={`${l.ts}-${i}`} className="flex gap-2">
              <span className="shrink-0 text-zinc-600">{new Date(l.ts).toLocaleTimeString()}</span>
              <span
                className={
                  l.kind === 'error' ? 'text-red-200/90' : l.kind === 'sent' ? 'text-zinc-400' : 'text-emerald-200/90'
                }
              >
                {l.text}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function OutcomePane({
  entry,
  label,
  autoLines,
  fetchedAt,
  market,
}: {
  entry: ClobBookEntry;
  label: string;
  autoLines: AutoLine[];
  fetchedAt: number | null;
  market: unknown | null;
}): ReactElement {
  const parsed = pickBookLevels(entry.book);
  const tob = topOfBook(entry.book);
  const mid = midPrice(entry.book);
  const intel = useMemo(() => computeBookIntel(entry.book), [entry.book]);
  const gammaStats = useMemo(() => pickGammaVolumeStats(market), [market]);
  const gammaLines = useMemo(() => formatGammaVolumeLines(gammaStats), [gammaStats]);
  const [now, setNow] = useState(() => Date.now());

  // Global clock tick for freshness badges / relative time. Keep low-frequency to avoid re-render thrash.
  useEffect(() => {
    // Drive countdown clocks (e.g. "Time remaining") at 1s resolution.
    // API polling still happens on its own cadence; this only updates the UI clock.
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const ageMs = fetchedAt == null ? null : now - fetchedAt;
  const live = ageMs != null && ageMs < 20_000;
  return (
    <div className="rounded-2xl border border-zinc-800/50 bg-gradient-to-b from-zinc-900/25 to-zinc-950/40 p-4 shadow-lg shadow-black/25 ring-1 ring-white/[0.03]">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-800/40 pb-3">
        <div className="text-[15px] font-semibold tracking-tight text-zinc-100">{label}</div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
              live ? 'border-emerald-700/40 bg-emerald-950/25 text-emerald-200' : 'border-zinc-700/40 bg-zinc-950/40 text-zinc-500'
            }`}
            title={fetchedAt ? `Last fetched ${new Date(fetchedAt).toLocaleTimeString()}` : 'Not fetched yet'}
          >
            {live ? 'LIVE' : 'STALE'}
          </div>
          <div className="rounded-md bg-zinc-900/60 px-2 py-1 font-mono text-[11px] text-zinc-400">
            mid {mid != null ? displayPrice(mid) : '—'} · bid {tob.bestBid != null ? displayPrice(tob.bestBid) : '—'} · ask{' '}
            {tob.bestAsk != null ? displayPrice(tob.bestAsk) : '—'}
          </div>
          <div className="rounded-md bg-zinc-900/60 px-2 py-0.5 font-mono text-[11px] text-zinc-500">{shortToken(entry.token)}</div>
        </div>
      </div>
      {entry.error ? (
        <div className="mt-3 rounded-xl border border-amber-800/30 bg-amber-950/20 px-3 py-2 text-xs leading-relaxed text-amber-100/90">
          {entry.error}
        </div>
      ) : null}
      {!entry.error ? (
        <div className="mt-3 rounded-xl border border-zinc-800/50 bg-zinc-900/30 px-3 py-2.5 ring-1 ring-white/[0.02]">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Book vs chart (entry / exit)</div>
          <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-zinc-400">
            {outcomeEntryExitHints({
              label,
              mid,
              bestBid: tob.bestBid,
              bestAsk: tob.bestAsk,
            }).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {!entry.error ? (
        <div className="mt-3 rounded-xl border border-indigo-900/35 bg-indigo-950/20 px-3 py-2.5 ring-1 ring-white/[0.02]">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-indigo-300/90">Volume & liquidity (Gamma)</div>
          <p className="mt-1 text-[10px] leading-snug text-zinc-500">
            From the market listing — useful for how much has traded overall; the ladder is still the live quote.
          </p>
          <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-indigo-100/85">
            {gammaLines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {!entry.error && intel ? (
        <div className="mt-3 rounded-xl border border-emerald-900/30 bg-emerald-950/15 px-3 py-2.5 ring-1 ring-white/[0.02]">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-300/90">Depth & microprice (this outcome)</div>
          <p className="mt-1 text-[10px] leading-snug text-zinc-500">
            Computed from the CLOB snapshot: where size sits vs mid, and a simple “air pocket” scan a few levels up the asks.
          </p>
          <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-emerald-100/90">
            {bookIntelLines(intel).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BookSideGrouped title="Buyable (asks)" levels={parsed.asks} tone="ask" />
        <BookSideGrouped title="Sellable (bids)" levels={parsed.bids} tone="bid" />
      </div>
      <AutoTerminal lines={autoLines} />
    </div>
  );
}

type ChatTurn = { role: 'user' | 'assistant'; content: string };

function OrderFlowAssistant({ apiAvailable, context }: { apiAvailable: boolean; context: string }): ReactElement {
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setErr(null);
    const next: ChatTurn[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setBusy(true);
    const res = await assistantChat({ messages: next, context: context || undefined, max_tokens: 560 });
    setBusy(false);
    if (isOk(res)) setMessages([...next, { role: 'assistant', content: res.data.message }]);
    else setErr(pretty(res));
  }

  return (
    <div className="flex h-full min-h-[22rem] flex-col rounded-2xl border border-zinc-800/50 bg-zinc-950/35 p-4 shadow-lg shadow-black/25 ring-1 ring-white/[0.02] xl:min-h-[32rem]">
      <div className="text-[15px] font-semibold tracking-tight text-zinc-100">Order-flow assistant</div>
      <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">
        The API calls your provider (Moonshot / OpenAI-compatible). Put{' '}
        <span className="rounded bg-zinc-900/80 px-1 font-mono text-zinc-400">MOONSHOT_API_KEY</span> or{' '}
        <span className="rounded bg-zinc-900/80 px-1 font-mono text-zinc-400">OPENAI_API_KEY</span> in{' '}
        <span className="font-mono text-zinc-400">.env</span> at the <span className="text-zinc-300">repo root</span> or in{' '}
        <span className="font-mono text-zinc-400">api/.env</span>, then restart <span className="font-mono text-zinc-400">npm run dev</span>.
        If replies fail, expand the red error — it often names a bad model or billing issue.
      </p>
      {!apiAvailable ? (
        <div className="mt-3 rounded-xl border border-amber-800/25 bg-amber-950/15 px-3 py-2 text-xs leading-relaxed text-amber-100/85">
          Assistant is off until the API reports a configured key (health check).
        </div>
      ) : null}
      <div className="mt-3 flex-1 space-y-2.5 overflow-y-auto rounded-xl border border-zinc-800/40 bg-black/20 p-3 text-sm shadow-inner shadow-black/20">
        {messages.length === 0 ? (
          <div className="text-xs leading-relaxed text-zinc-500">
            Ask how to read the ladder, what tighter asks imply, or how UP/DOWN books relate. Context updates when you change markets.
          </div>
        ) : (
          messages.map((m, i) => (
            <div
              key={i}
              className={`rounded-xl px-3 py-2 text-xs leading-relaxed ${
                m.role === 'user'
                  ? 'ml-2 border border-indigo-500/20 bg-indigo-950/35 text-indigo-50'
                  : 'mr-2 border border-zinc-700/30 bg-zinc-900/55 text-zinc-200'
              }`}
            >
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">{m.role}</div>
              <div className="whitespace-pre-wrap text-[13px] leading-relaxed">{m.content}</div>
            </div>
          ))
        )}
        {busy ? <div className="text-xs text-indigo-300/90">Thinking…</div> : null}
        {err ? <pre className="overflow-auto rounded-lg bg-red-950/20 p-2 text-xs text-red-200/90">{err}</pre> : null}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={!apiAvailable || busy}
          placeholder={apiAvailable ? 'Ask about this book…' : 'Configure API key first'}
          className="min-w-0 flex-1 rounded-xl border border-zinc-700/50 bg-zinc-900/40 px-3 py-2.5 text-[13px] text-zinc-100 outline-none ring-indigo-500/0 transition-shadow placeholder:text-zinc-600 focus:border-indigo-500/40 focus:ring-2 focus:ring-indigo-500/25 disabled:opacity-50"
        />
        <button
          type="button"
          disabled={!apiAvailable || busy}
          onClick={() => void send()}
          className="shrink-0 rounded-xl bg-indigo-500 px-4 py-2.5 text-xs font-semibold text-white shadow-md shadow-indigo-950/40 transition-colors hover:bg-indigo-400 disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}

type LoadMarketResult = { ok: true; slug: string; data: unknown } | { ok: false };
type MainTab =
  | 'book'
  | 'flowzones'
  | 'signals'
  | 'tracking'
  | 'tradehistory'
  | 'dualptb'
  | 'threeup'
  | 'command'
  | 'unified'
  | 'multiscan'
  | 'momentum'
  | 'watch'
  | 'workspace'
  | 'assistant'
  | 'raw';

function mainTabTitle(tab: MainTab): string {
  switch (tab) {
    case 'book':
      return 'Book';
    case 'flowzones':
      return 'Flow Zones';
    case 'signals':
      return 'Signals';
    case 'tracking':
      return 'Tracking';
    case 'tradehistory':
      return 'Trade history';
    case 'dualptb':
      return 'Dual PTB';
    case 'threeup':
      return '3-up';
    case 'command':
      return 'Command';
    case 'unified':
      return 'Unified';
    case 'multiscan':
      return 'Multi scan';
    case 'momentum':
      return '+4¢ scalps';
    case 'watch':
      return 'Watch';
    case 'workspace':
      return 'Workspace';
    case 'assistant':
      return 'Assistant';
    case 'raw':
      return 'Raw';
  }
}

function MainTabButton({
  id,
  label,
  title: titleAttr,
  active,
  onSelect,
}: {
  id: MainTab;
  label: string;
  /** Full label for hover (when `label` is shortened). */
  title?: string;
  active: boolean;
  onSelect: (id: MainTab) => void;
}): ReactElement {
  return (
    <button
      type="button"
      title={titleAttr ?? label}
      onClick={() => onSelect(id)}
      className={`border-b-2 px-2.5 py-2 text-[13px] font-medium transition-colors ${
        active
          ? 'border-amber-500/75 text-zinc-100'
          : 'border-transparent text-zinc-500 hover:text-zinc-300'
      }`}
    >
      {label}
    </button>
  );
}

function App() {
  const [apiHealth, setApiHealth] = useState<string>('Checking API…');
  const [q, setQ] = useState('');
  const [markets, setMarkets] = useState<unknown[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string>('');
  const [marketJson, setMarketJson] = useState<unknown | null>(null);
  const [books, setBooks] = useState<ClobBookEntry[] | null>(null);
  const [booksLoading, setBooksLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marketsError, setMarketsError] = useState<string | null>(null);
  const [slugInput, setSlugInput] = useState('');
  const [outcomeTab, setOutcomeTab] = useState(0);
  const [assistantAvailable, setAssistantAvailable] = useState(false);
  const [shortcutBusy, setShortcutBusy] = useState<{ asset: UpdownShortcutAsset; interval: UpdownInterval } | null>(null);
  const [lastShortcut, setLastShortcut] = useState<{ asset: UpdownShortcutAsset; interval: UpdownInterval } | null>(null);
  const [mainTab, setMainTab] = useState<MainTab>('dualptb');
  const [threeUpInterval, setThreeUpInterval] = useState<UpdownInterval>(() => {
    if (typeof window === 'undefined') return '5m';
    try {
      const s = localStorage.getItem(PTB_THREE_UP_INTERVAL_KEY);
      if (s === '5m' || s === '15m') return s;
    } catch {
      /* ignore */
    }
    return '5m';
  });
  const [_threeUpSlugs, setThreeUpSlugs] = useState<Record<string, string>>({});
  const [threeUpMeta, setThreeUpMeta] = useState<Record<string, { ptb: number | null; endsInMs: number | null }>>({});
  const [commandSelected, setCommandSelected] = useState<MarketKey>('btc');
  const [ptbWatchSlugs, setPtbWatchSlugs] = useState<string[]>(() => readStringArray(PTB_WATCH_SLUGS_KEY, 12));
  const [ptbWatchRecentSlugs, setPtbWatchRecentSlugs] = useState<string[]>(() => readStringArray(PTB_WATCH_RECENT_KEY, 24));
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoLinesBySlug, setAutoLinesBySlug] = useState<Record<string, AutoLine[]>>({});
  const [, setAutoThreadBySlug] = useState<Record<string, { role: 'user' | 'assistant'; content: string }[]>>({});
  const [, setAutoBiasBySlug] = useState<Record<string, { bias: string; confidence: number | null; why: string }>>({});
  const autoThreadRef = useRef<Record<string, { role: 'user' | 'assistant'; content: string }[]>>({});
  const [booksFetchedAt, setBooksFetchedAt] = useState<number | null>(null);
  const [chartEnabled, setChartEnabled] = useState(true);
  const [chartSeriesBySlug, setChartSeriesBySlug] = useState<Record<string, Record<string, SeriesPoint[]>>>({});
  const [flowSeriesBySlug, setFlowSeriesBySlug] = useState<Record<string, Record<string, BookSnapshot[]>>>({});
  const [flowMode, setFlowMode] = useState<'price' | 'flow'>('flow');
  const [ssrPriceToBeat, setSsrPriceToBeat] = useState<number | null>(null);
  const [rtdsSpot, setRtdsSpot] = useState<number | null>(null);
  const [rtdsTickAt, setRtdsTickAt] = useState<number | null>(null);
  const [spotSeriesBySlug, setSpotSeriesBySlug] = useState<Record<string, SpotPoint[]>>({});
  /** RTDS Chainlink series per `btc/usd` | `eth/usd` | `sol/usd` — drives multi-asset scan + selected slug. */
  const [spotBySymbol, setSpotBySymbol] = useState<Record<string, SpotPoint[]>>({});
  const [watchMetaBySlug, setWatchMetaBySlug] = useState<Record<string, { ptb: number | null; endsInMs: number | null }>>({});
  const [now, setNow] = useState(() => Date.now());
  const spotBySymbolRef = useRef<Record<string, SpotPoint[]>>({});

  const [globalTradeLane, setGlobalTradeLane] = useState<'up' | 'down'>('up');
  const [tradePanelOpen, setTradePanelOpen] = useState(false);
  const [positionsPanelOpen, setPositionsPanelOpen] = useState(false);
  const [globalTradeLocked, setGlobalTradeLocked] = useState(false);
  const [updownPickerOpen, setUpdownPickerOpen] = useState(false);
  /** Multiple trade tabs in the slide panel; switching re-loads that slug (one CLOB at a time). */
  const [tradeSessionTabs, setTradeSessionTabs] = useState<TradeSessionTab[]>([]);
  const [activeTradeSessionTabId, setActiveTradeSessionTabId] = useState<string | null>(null);
  const pendingTradeTabSlugRef = useRef<string | null>(null);
  /** So closing all tabs does not immediately auto-reseed (user can run empty, then add a new tab). */
  const tradeSessionAutoSeededRef = useRef(false);
  const [globalTradeContext, setGlobalTradeContext] = useState<{
    slug: string;
    question: string;
    upLabel: string;
    downLabel: string;
    upToken: string;
    downToken: string;
  } | null>(null);

  useEffect(() => {
    spotBySymbolRef.current = spotBySymbol;
  }, [spotBySymbol]);

  const prevDepthMapsRef = useRef<Record<string, { bids: Map<string, number>; asks: Map<string, number> }>>({});

  const tokenIds = useMemo(() => pickTokenIds(marketJson), [marketJson]);
  const outcomeLabels = useMemo(() => pickOutcomeLabels(marketJson), [marketJson]);

  const globalUpDown = useMemo(() => {
    const resolved = resolveUpDownIndices(outcomeLabels, marketJson);
    if (resolved) return resolved;
    // Fallback for non UP/DOWN markets: just use first 2 outcomes if available.
    if (outcomeLabels.length >= 2) return { up: 0, down: 1 };
    return null;
  }, [outcomeLabels, marketJson]);
  const globalTradeReady = Boolean(books && books.length >= 2 && outcomeLabels.length >= 2 && globalUpDown);
  const globalUpLabel = globalUpDown ? (outcomeLabels[globalUpDown.up] ?? 'UP') : 'UP';
  const globalDownLabel = globalUpDown ? (outcomeLabels[globalUpDown.down] ?? 'DOWN') : 'DOWN';
  const globalUpToken = globalUpDown && books ? books[globalUpDown.up]?.token ?? '' : '';
  const globalDownToken = globalUpDown && books ? books[globalUpDown.down]?.token ?? '' : '';
  const globalMarketQuestion = useMemo(() => pickMarketQuestion(marketJson), [marketJson]);

  const currentTradeContext = useMemo(() => {
    const slug = selectedSlug.trim();
    return {
      slug,
      question: globalMarketQuestion,
      upLabel: globalUpLabel,
      downLabel: globalDownLabel,
      upToken: globalUpToken,
      downToken: globalDownToken,
    };
  }, [globalDownLabel, globalDownToken, globalMarketQuestion, globalUpLabel, globalUpToken, selectedSlug]);

  useEffect(() => {
    if (globalTradeLocked) return;
    if (!currentTradeContext.slug) {
      setGlobalTradeContext(null);
      return;
    }
    setGlobalTradeContext(currentTradeContext);
  }, [currentTradeContext, globalTradeLocked]);

  const effectiveTradeContext = globalTradeLocked && globalTradeContext ? globalTradeContext : currentTradeContext;
  const effectiveTradeReady = Boolean(effectiveTradeContext.slug) && globalTradeReady;
  const effectiveTradeEnabled = Boolean(effectiveTradeContext.upToken && effectiveTradeContext.downToken);

  const signalsProbMids = useMemo(() => {
    if (!selectedSlug || !books || books.length < 2 || outcomeLabels.length < 2) {
      return { up: [] as SpotPoint[], down: [] as SpotPoint[] };
    }
    const idx = resolveUpDownIndices(outcomeLabels, marketJson);
    if (!idx) return { up: [] as SpotPoint[], down: [] as SpotPoint[] };
    const tokU = books[idx.up]?.token;
    const tokD = books[idx.down]?.token;
    const m = chartSeriesBySlug[selectedSlug] ?? {};
    const parsed = parseUpdownSlug(selectedSlug);
    const stepSec = parsed?.stepSec ?? 300;
    const clean = (arr: SeriesPoint[]): SpotPoint[] => {
      const pts = arr
        .filter((p) => typeof p.v === 'number' && Number.isFinite(p.v as number) && Number.isFinite(p.t as number))
        .map((p) => ({ t: p.t, v: p.v as number }));
      if (pts.length < 2) return pts;
      const tMax = pts[pts.length - 1]!.t;
      // Series timestamps may be either epoch ms or epoch seconds depending on the source.
      const isEpochMs = tMax > 50_000_000_000; // ~year 1971 in ms; safely above any "seconds" epoch.
      const windowT = isEpochMs ? stepSec * 1000 : stepSec;
      const tMinKeep = tMax - windowT;
      // Time-window slice so BTC 5m never renders as longer windows.
      const sliced = pts.filter((p) => p.t >= tMinKeep).slice(-480);
      return sliced.length >= 2 ? sliced : pts.slice(-220);
    };
    return {
      up: tokU ? clean(m[tokU] ?? []) : [],
      down: tokD ? clean(m[tokD] ?? []) : [],
    };
  }, [books, chartSeriesBySlug, marketJson, outcomeLabels, selectedSlug]);

  const tradePanelBookMids = useMemo(() => {
    if (!books || books.length < 2 || outcomeLabels.length < 2) {
      return { up: null as number | null, down: null as number | null };
    }
    const idx = resolveUpDownIndices(outcomeLabels, marketJson);
    if (!idx) return { up: null, down: null };
    const upE = books[idx.up];
    const downE = books[idx.down];
    return {
      up: upE && !upE.error ? midPrice(upE.book) : null,
      down: downE && !downE.error ? midPrice(downE.book) : null,
    };
  }, [books, marketJson, outcomeLabels]);

  const tradePanelBookTouch = useMemo(() => {
    if (!books || books.length < 2 || outcomeLabels.length < 2) {
      return { up: null as ReturnType<typeof topOfBook> | null, down: null as ReturnType<typeof topOfBook> | null };
    }
    const idx = resolveUpDownIndices(outcomeLabels, marketJson);
    if (!idx) return { up: null, down: null };
    const upE = books[idx.up];
    const downE = books[idx.down];
    return {
      up: upE && !upE.error ? topOfBook(upE.book) : null,
      down: downE && !downE.error ? topOfBook(downE.book) : null,
    };
  }, [books, marketJson, outcomeLabels]);

  const loadMarket = useCallback(async (slug: string): Promise<LoadMarketResult> => {
    const clean = normalizeMarketLookupRef(slug);
    queueMicrotask(() => setMainTab((tab) => (tab === 'dualptb' ? tab : 'book')));
    setSelectedSlug(clean);
    setSlugInput(clean || slug.trim());
    setError(null);
    setMarketJson(null);
    setBooks(null);
    if (!clean) return { ok: false };
    const res = await marketsGet(clean);
    if (isOk(res)) {
      setMarketJson(res.data);
      return { ok: true, slug: clean, data: res.data };
    }
    setError(pretty(res));
    return { ok: false };
  }, []);

  const onGlobalTradeLaneChange = useCallback(
    (lane: 'up' | 'down') => {
      setGlobalTradeLane(lane);
      if (!activeTradeSessionTabId) return;
      setTradeSessionTabs((list) => list.map((t) => (t.id === activeTradeSessionTabId ? { ...t, lane } : t)));
    },
    [activeTradeSessionTabId],
  );

  const onSelectTradeSessionTab = useCallback(
    (id: string) => {
      const t = tradeSessionTabs.find((x) => x.id === id);
      if (!t?.slug) return;
      pendingTradeTabSlugRef.current = t.slug;
      setActiveTradeSessionTabId(id);
      setGlobalTradeLane(t.lane);
      void loadMarket(t.slug);
    },
    [tradeSessionTabs, loadMarket],
  );

  const onAddTradeSessionTab = useCallback(() => {
    const ctx = effectiveTradeContext;
    if (!ctx.slug) return;
    const id = `ts-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    setTradeSessionTabs((list) => [
      ...list,
      { id, label: shortTradeTabLabel(ctx.question, ctx.slug), slug: ctx.slug, lane: globalTradeLane },
    ]);
    setActiveTradeSessionTabId(id);
  }, [effectiveTradeContext, globalTradeLane]);

  const onCloseTradeSessionTab = useCallback(
    (id: string) => {
      setTradeSessionTabs((list) => {
        const wasActive = id === activeTradeSessionTabId;
        const next = list.filter((t) => t.id !== id);
        if (wasActive) {
          const pick = next[0];
          queueMicrotask(() => {
            if (pick) {
              pendingTradeTabSlugRef.current = pick.slug;
              setActiveTradeSessionTabId(pick.id);
              setGlobalTradeLane(pick.lane);
              void loadMarket(pick.slug);
            } else {
              pendingTradeTabSlugRef.current = null;
              setActiveTradeSessionTabId(null);
            }
          });
        }
        return next;
      });
    },
    [activeTradeSessionTabId, loadMarket],
  );

  // First time a market is available, create one default session tab. After the user closes all tabs, do not auto-reseed.
  useEffect(() => {
    if (tradeSessionTabs.length > 0) {
      tradeSessionAutoSeededRef.current = true;
      return;
    }
    if (tradeSessionAutoSeededRef.current) return;
    const slug = currentTradeContext.slug?.trim();
    if (!slug) return;
    tradeSessionAutoSeededRef.current = true;
    const id = `s0-${slug.replace(/[^a-z0-9-]/gi, '').slice(0, 20)}`;
    setTradeSessionTabs([{ id, label: shortTradeTabLabel(currentTradeContext.question, slug), slug, lane: globalTradeLane }]);
    setActiveTradeSessionTabId(id);
  }, [currentTradeContext.slug, currentTradeContext.question, globalTradeLane, tradeSessionTabs.length]);

  // Keep the active session tab in sync with the loaded market, unless we’re mid tab-switched load.
  useEffect(() => {
    const slug = currentTradeContext.slug?.trim();
    if (!slug) return;

    if (pendingTradeTabSlugRef.current) {
      if (selectedSlug.trim() !== pendingTradeTabSlugRef.current) {
        return;
      }
      pendingTradeTabSlugRef.current = null;
    }

    if (!activeTradeSessionTabId) return;
    setTradeSessionTabs((list) => {
      if (!list.some((t) => t.id === activeTradeSessionTabId)) return list;
      return list.map((t) =>
        t.id === activeTradeSessionTabId
          ? { ...t, slug, label: shortTradeTabLabel(currentTradeContext.question, slug) }
          : t,
      );
    });
  }, [activeTradeSessionTabId, currentTradeContext.question, currentTradeContext.slug, selectedSlug]);

  const loadBooks = useCallback(async (ids: string[]) => {
    if (ids.length === 0) {
      setBooks(null);
      return;
    }
    setBooksLoading(true);
    setError(null);
    const res = await clobBooks(ids);
    setBooksLoading(false);
    if (isOk(res)) {
      setBooks(res.data);
      const ts = Date.now();
      setBooksFetchedAt(ts);
      // update chart series
      setChartSeriesBySlug((m) => {
        if (!selectedSlug) return m;
        const existingForSlug = m[selectedSlug] ?? {};
        const nextForSlug: Record<string, SeriesPoint[]> = { ...existingForSlug };
        for (const e of res.data) {
          const token = e.token;
          const v = e.error ? null : midPrice(e.book);
          const prev = nextForSlug[token] ?? [];
          nextForSlug[token] = [...prev, { t: ts, v }].slice(-180);
        }
        return { ...m, [selectedSlug]: nextForSlug };
      });

      // update order-flow metrics series (per token)
      setFlowSeriesBySlug((m) => {
        if (!selectedSlug) return m;
        const existingForSlug = m[selectedSlug] ?? {};
        const nextForSlug: Record<string, BookSnapshot[]> = { ...existingForSlug };
        for (const e of res.data) {
          const token = e.token;
          const key = `${selectedSlug}:${token}`;
          const prevMaps = prevDepthMapsRef.current[key] ?? null;
          const prev = nextForSlug[token] ?? [];
          if (e.error) continue;
          const { snap, next } = snapshotFromBook(e.book, ts, prevMaps);
          prevDepthMapsRef.current[key] = next;
          nextForSlug[token] = [...prev, snap].slice(-360);
        }
        return { ...m, [selectedSlug]: nextForSlug };
      });
    }
    else setError(pretty(res));
  }, [selectedSlug, ptbWatchSlugs]);

  // Prefer WS market channel (instant); polling remains as a fallback.
  const booksWsRef = useRef<ReturnType<typeof openClobMarketChannel> | null>(null);
  const booksCacheRef = useRef<Map<string, { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] }>>(new Map());
  const booksWsIdsRef = useRef<string>('');
  const booksRafRef = useRef<number | null>(null);
  const booksDirtyRef = useRef(false);

  useEffect(() => {
    const ids = tokenIds;
    const key = ids.join(',');
    if (!ids || ids.length === 0) {
      booksWsRef.current?.close();
      booksWsRef.current = null;
      booksCacheRef.current = new Map();
      booksWsIdsRef.current = '';
      return;
    }
    if (booksWsRef.current && booksWsIdsRef.current === key) return;

    booksWsRef.current?.close();
    booksWsRef.current = null;
    booksCacheRef.current = new Map();
    booksWsIdsRef.current = key;

    // Keep UI responsive while we wait for first WS book snapshot.
    setBooksLoading(true);
    setError(null);

    const toEntries = () => {
      const out: { token: string; book: unknown; error: string | null }[] = [];
      for (const token of ids) {
        const b = booksCacheRef.current.get(token);
        out.push({ token, book: b ? { bids: b.bids, asks: b.asks } : { bids: [], asks: [] }, error: null });
      }
      return out;
    };

    const flushBooks = () => {
      booksRafRef.current = null;
      if (!booksDirtyRef.current) return;
      booksDirtyRef.current = false;
      const ts = Date.now();
      setBooks(toEntries());
      setBooksFetchedAt(ts);
      setBooksLoading(false);
    };

    const scheduleFlush = () => {
      booksDirtyRef.current = true;
      if (booksRafRef.current != null) return;
      booksRafRef.current = window.requestAnimationFrame(flushBooks);
    };

    booksWsRef.current = openClobMarketChannel({
      assetIds: ids,
      onBook: (assetId, book) => {
        booksCacheRef.current.set(assetId, book);
        scheduleFlush();
      },
      onPriceChanges: (changes) => {
        let touched = false;
        for (const c of changes) {
          const id = c.asset_id;
          if (!ids.includes(id)) continue;
          const book = booksCacheRef.current.get(id);
          if (!book) continue;
          const side = c.side === 'BUY' ? 'bids' : 'asks';
          const px = String(c.price);
          const sz = String(c.size);
          const arr = book[side];
          const idx = arr.findIndex((x) => x.price === px);
          if (sz === '0' || sz === '0.0' || sz === '0.00') {
            if (idx !== -1) arr.splice(idx, 1);
          } else if (idx !== -1) {
            arr[idx] = { price: px, size: sz };
          } else {
            arr.push({ price: px, size: sz });
          }
          touched = true;
        }
        if (touched) scheduleFlush();
      },
    });

    return () => {
      if (booksRafRef.current != null) window.cancelAnimationFrame(booksRafRef.current);
      booksRafRef.current = null;
      booksDirtyRef.current = false;
      booksWsRef.current?.close();
      booksWsRef.current = null;
      booksCacheRef.current = new Map();
      booksWsIdsRef.current = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenIds.join(',')]);

  // When enabled, poll books every 5s to drive the chart (fallback).
  useEffect(() => {
    if (!chartEnabled) return;
    if (!tokenIds || tokenIds.length === 0) return;
    if (!selectedSlug) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      await loadBooks(tokenIds);
    };
    const id = window.setInterval(() => void tick(), 5_000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [chartEnabled, loadBooks, selectedSlug, tokenIds]);

  useEffect(() => {
    void (async () => {
      setMarketsError(null);
      const h = await health();
      if (isOk(h)) {
        setAssistantAvailable(h.data.assistant_available === true);
        const g = h.data.gamma_reachable === true ? ' · Gamma OK' : h.data.gamma_reachable === false ? ' · Gamma unreachable' : '';
        const ap = h.data.assistant_provider ? ` · ${String(h.data.assistant_provider).toUpperCase()}` : '';
        const am = h.data.assistant_model ? `/${h.data.assistant_model}` : '';
        const a =
          h.data.assistant_available === true
            ? ` · Assistant${ap}${am}`
            : h.data.assistant_available === false
              ? ' · Assistant (set MOONSHOT_API_KEY or OPENAI_API_KEY in repo or api/.env)'
              : '';
        setApiHealth(
          h.data.trading_ready === true
            ? `API OK — trading ready${h.data.polymarket ? ` · ${h.data.polymarket}` : ' · (no polymarket CLI)'}${g}${a}`
            : h.data.polymarket
              ? `API OK — ${h.data.polymarket}${g}${a}`
              : `API OK (HTTP mode — no polymarket CLI)${g}${a}`,
        );
      }
      else setApiHealth(`API error: ${h.error}${!isOk(h) && h.error === 'fetch_failed' ? ' — is the API running on :8787?' : ''}`);

      const list = await marketsList(25);
      if (isOk(list)) {
        setMarkets(asMarketRows(list.data));
        if (asMarketRows(list.data).length === 0) {
          setMarketsError('Markets list returned zero rows. Is the Polymarket CLI installed and on PATH? Try `Open by slug` below.');
        }
      } else {
        setMarkets([]);
        setMarketsError(pretty(list) + apiReachabilityHint(list));
      }
    })();
  }, []);

  useEffect(() => {
    if (tokenIds.length === 0) {
      queueMicrotask(() => setBooks(null));
      return;
    }
    queueMicrotask(() => void loadBooks(tokenIds));
  }, [tokenIds, loadBooks]);

  useEffect(() => {
    if (!books || books.length === 0) {
      queueMicrotask(() => setOutcomeTab(0));
      return;
    }
    const n = books.length;
    queueMicrotask(() => setOutcomeTab((t) => Math.min(Math.max(0, t), n - 1)));
  }, [books]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const slug = (params.get('slug') ?? params.get('market') ?? '').trim();
    if (!slug) return;
    queueMicrotask(() => void loadMarket(slug));
  }, [loadMarket]);

  useEffect(() => {
    const slug = selectedSlug.trim();
    if (!slug) return;
    let stopped = false;
    const tick = async () => {
      const ptb = await priceToBeat(slug);
      if (stopped) return;
      // Keep last good PTB on transient fetch errors (prevents chart flicker).
      if (isOk(ptb)) setSsrPriceToBeat(ptb.data.price_to_beat);
    };
    void tick();
    const id = window.setInterval(() => void tick(), 20_000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [selectedSlug]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PTB_THREE_UP_INTERVAL_KEY, threeUpInterval);
    } catch {
      /* ignore */
    }
  }, [threeUpInterval]);

  useEffect(() => {
    writeStringArray(PTB_WATCH_SLUGS_KEY, ptbWatchSlugs);
  }, [ptbWatchSlugs]);

  useEffect(() => {
    let stopped = false;
    const assets: UpdownShortcutAsset[] = ['btc', 'eth', 'sol'];
    const tick = async () => {
      const res = await Promise.all(assets.map((a) => marketsUpdownShortcut(a, threeUpInterval)));
      if (stopped) return;
      const nextSlugs: Record<string, string> = {};
      for (let i = 0; i < assets.length; i++) {
        const a = assets[i]!;
        const r = res[i]!;
        if (!isOk(r)) continue;
        const cur = r.data.slug;
        // 5m: prior window — PTB is previous bucket open; smoother right after a roll. 15m: use the live window
        // (prior is a full 15m back and is often the wrong/closed book for the round you are trading).
        const slug = threeUpInterval === '15m' ? cur : (nextUpdownSlug(cur, -1) ?? cur);
        nextSlugs[a] = slug;
      }
      setThreeUpSlugs(nextSlugs);

      const metas = await Promise.all(
        Object.entries(nextSlugs).map(async ([asset, slug]) => {
          const [mRes, pRes] = await Promise.all([marketsGet(slug), priceToBeat(slug)]);
          const ptb = isOk(pRes) ? pRes.data.price_to_beat : null;
          let endsInMs: number | null = null;
          if (isOk(mRes) && mRes.data && typeof mRes.data === 'object') {
            const endRaw = (mRes.data as Record<string, unknown>).endDate;
            if (typeof endRaw === 'string') {
              const t = Date.parse(endRaw);
              if (Number.isFinite(t)) endsInMs = t - Date.now();
            }
          }
          return { asset, ptb, endsInMs };
        }),
      );
      if (stopped) return;
      setThreeUpMeta((prev) => {
        const next = { ...prev };
        for (const m of metas) next[m.asset] = { ptb: m.ptb, endsInMs: m.endsInMs };
        return next;
      });
    };
    void tick();
    const id = window.setInterval(() => void tick(), 20_000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [threeUpInterval]);

  useEffect(() => {
    writeStringArray(PTB_WATCH_RECENT_KEY, ptbWatchRecentSlugs);
  }, [ptbWatchRecentSlugs]);

  useEffect(() => {
    const s = selectedSlug.trim();
    if (!s) return;
    setPtbWatchRecentSlugs((prev) => {
      const next = [s, ...prev.filter((x) => x !== s)];
      return next.slice(0, 24);
    });
  }, [selectedSlug]);

  // (intentionally no second clock interval)

  const spotLenForRtds = spotSeriesBySlug[selectedSlug]?.length ?? 0;
  const rtdsPollFast = parseUpdownSlug(selectedSlug) != null && spotLenForRtds < 2;

  useEffect(() => {
    const symFromSlug = (slug: string): string | null => {
      const m = slug.trim().toLowerCase().match(/^([a-z0-9]{2,10})-updown-(5m|15m)-(\d+)$/);
      if (!m) return null;
      return `${m[1]!}/usd`;
    };
    const collect = (): string[] => {
      const s = new Set<string>(['btc/usd', 'eth/usd', 'sol/usd']);
      const a = symFromSlug(selectedSlug);
      if (a) s.add(a);
      for (const w of ptbWatchSlugs) {
        const sym = symFromSlug(w);
        if (sym) s.add(sym);
      }
      return Array.from(s).slice(0, 10);
    };
    const SYMS = collect();
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const results = await Promise.all(SYMS.map((s) => rtdsCrypto(s)));
      const base = spotBySymbolRef.current;
      const next: Record<string, SpotPoint[]> = { ...base };
      for (let i = 0; i < SYMS.length; i++) {
        const sym = SYMS[i]!;
        const res = results[i]!;
        if (!isOk(res)) continue;
        next[sym] = mergeSpotHistory(base[sym] ?? [], res.data);
      }
      setSpotBySymbol(next);
      const p = parseUpdownSlug(selectedSlug);
      if (!p) {
        queueMicrotask(() => {
          setRtdsSpot(null);
          setRtdsTickAt(null);
          setSpotSeriesBySlug((m) => {
            if (!selectedSlug.trim()) return m;
            const { [selectedSlug]: _removed, ...rest } = m;
            return rest;
          });
        });
        return;
      }
      const sym = `${p.asset}/usd`;
      const series = next[sym] ?? [];
      queueMicrotask(() => {
        setSpotSeriesBySlug((m) => ({ ...m, [selectedSlug]: series }));
        if (series.length > 0) {
          const last = series[series.length - 1]!;
          setRtdsSpot(last.v);
          setRtdsTickAt(last.t);
        }
      });
    };
    void tick();
    const bootTimers = [
      window.setTimeout(() => {
        if (!stopped) void tick();
      }, 140),
      window.setTimeout(() => {
        if (!stopped) void tick();
      }, 400),
    ];
    const intervalMs = rtdsPollFast ? 750 : 2_000;
    const id = window.setInterval(() => void tick(), intervalMs);
    return () => {
      stopped = true;
      window.clearInterval(id);
      for (const t of bootTimers) window.clearTimeout(t);
    };
  }, [selectedSlug, ptbWatchSlugs, rtdsPollFast]);

  useEffect(() => {
    const slugs = [...new Set(ptbWatchSlugs.filter((s) => parseUpdownSlug(s) != null))];
    if (slugs.length === 0) {
      queueMicrotask(() => setWatchMetaBySlug({}));
      return;
    }
    let cancelled = false;
    const run = async () => {
      const results = await Promise.all(
        slugs.map(async (slug) => {
          const [mRes, pRes] = await Promise.all([marketsGet(slug), priceToBeat(slug)]);
          // Keep last good PTB if one poll fails (prevents watch grid flicker).
          const prevPtb = watchMetaBySlug[slug]?.ptb ?? null;
          const ptb = isOk(pRes) ? pRes.data.price_to_beat : prevPtb;
          let endsInMs: number | null = null;
          if (isOk(mRes) && mRes.data && typeof mRes.data === 'object') {
            const endRaw = (mRes.data as Record<string, unknown>).endDate;
            if (typeof endRaw === 'string') {
              const t = Date.parse(endRaw);
              if (Number.isFinite(t)) endsInMs = t - Date.now();
            }
          }
          return { slug, ptb, endsInMs };
        }),
      );
      if (cancelled) return;
      setWatchMetaBySlug((prev) => {
        const next = { ...prev };
        for (const r of results) {
          next[r.slug] = { ptb: r.ptb, endsInMs: r.endsInMs };
        }
        return next;
      });
    };
    void run();
    const id = window.setInterval(() => void run(), 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [ptbWatchSlugs]);

  const marketEndsInMs = useMemo(() => {
    if (!marketJson || typeof marketJson !== 'object') return null;
    const endRaw = (marketJson as Record<string, unknown>).endDate;
    if (typeof endRaw !== 'string') return null;
    const t = Date.parse(endRaw);
    if (!Number.isFinite(t)) return null;
    return t - now;
  }, [marketJson, now]);

  const multiScanRows: PtbMultiAssetRow[] = useMemo(() => {
    return ptbWatchSlugs
      .map((slug) => {
        const p = parseUpdownSlug(slug);
        if (!p) return null;
        const sym = `${p.asset}/usd`;
        const spot = spotBySymbol[sym] ?? [];
        const meta = watchMetaBySlug[slug];
        const ptb = meta?.ptb ?? (slug === selectedSlug ? ssrPriceToBeat : null);
        let endsMs: number | null = meta?.endsInMs ?? null;
        if (slug === selectedSlug && marketEndsInMs != null) endsMs = marketEndsInMs;
        const lastMs = spot.length ? spot[spot.length - 1]!.t : null;
        return {
          slug,
          label: `${p.asset.toUpperCase()}/USD`,
          spot,
          priceToBeat: ptb,
          endsInMs: endsMs,
          lastUpdateMs: lastMs,
        };
      })
      .filter((x): x is PtbMultiAssetRow => x != null);
  }, [ptbWatchSlugs, spotBySymbol, watchMetaBySlug, selectedSlug, ssrPriceToBeat, marketEndsInMs]);

  const updownParsed = useMemo(() => parseUpdownSlug(selectedSlug), [selectedSlug]);
  const updownPickerItems = useMemo(() => {
    const p = updownParsed;
    if (!p) return [];
    const step = p.stepSec;
    // Snap to exact 5m/15m boundary. (ts is epoch seconds.)
    const snapped = Math.floor(p.ts / step) * step;
    const items: { slug: string; label: string; ts: number }[] = [];
    // Show the last ~2 hours of windows (24×5m = 2h; 12×15m = 3h).
    const count = p.interval === '15m' ? 12 : 24;
    for (let i = 0; i < count; i++) {
      const ts = snapped - i * step;
      const slug = `${p.asset}-updown-${p.interval}-${ts}`;
      const d = new Date(ts * 1000);
      const hh = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      items.push({ slug, label: hh, ts });
    }
    return items;
  }, [updownParsed]);
  const [updownLiveSlugFromApi, setUpdownLiveSlugFromApi] = useState<string | null>(null);

  // For Up/Down markets, use the API's notion of "live" (bucket) rather than the browser clock.
  useEffect(() => {
    if (!updownParsed) {
      setUpdownLiveSlugFromApi(null);
      return;
    }
    const shortcutAsset = updownParsed.asset;
    if (!isShortcutAsset(shortcutAsset)) {
      // We can still stream spot from RTDS if available, but the shortcut API is BTC/ETH/SOL only.
      setUpdownLiveSlugFromApi(null);
      return;
    }
    let stopped = false;
    const tick = async () => {
      const res = await marketsUpdownShortcut(shortcutAsset, updownParsed.interval);
      if (stopped) return;
      if (isOk(res) && typeof res.data.slug === 'string' && res.data.slug) setUpdownLiveSlugFromApi(res.data.slug);
    };
    void tick();
    const id = window.setInterval(() => void tick(), 20_000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [updownParsed]);

  const updownBehindBySec = useMemo(() => {
    const p = updownParsed;
    if (!p) return null;
    const live = updownLiveSlugFromApi ? parseUpdownSlug(updownLiveSlugFromApi) : null;
    if (!live || live.asset !== p.asset || live.interval !== p.interval) return null;
    return live.ts - p.ts;
  }, [updownParsed, updownLiveSlugFromApi]);

  const assistantContext = useMemo(
    () => buildAssistantContext(selectedSlug, marketJson, books, outcomeLabels),
    [selectedSlug, marketJson, books, outcomeLabels],
  );

  const rollingCtxText = useMemo(() => {
    if (!selectedSlug || !books || books.length === 0) return '';
    const token = books[outcomeTab]?.token;
    const flow = token ? flowSeriesBySlug[selectedSlug]?.[token] ?? [] : [];
    const spot = spotSeriesBySlug[selectedSlug] ?? [];
    const ctx = buildRollingContext({ spotSeries: spot, priceToBeat: ssrPriceToBeat, flowSeries: flow });
    return rollingContextText(ctx);
  }, [books, outcomeTab, flowSeriesBySlug, selectedSlug, spotSeriesBySlug, ssrPriceToBeat]);

  const pushAutoLine = useCallback(
    (line: AutoLine) => {
      if (!selectedSlug) return;
      setAutoLinesBySlug((m) => ({
        ...m,
        [selectedSlug]: [...(m[selectedSlug] ?? []), line].slice(-80),
      }));
    },
    [selectedSlug],
  );

  useEffect(() => {
    if (!autoEnabled) return;
    if (!assistantAvailable) return;
    if (!selectedSlug) return;
    if (!books || books.length === 0) return;

    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (autoBusy) return;
      setAutoBusy(true);
      const ts0 = Date.now();
      pushAutoLine({ ts: ts0, kind: 'sent', text: 'sent context →' });
      try {
        const isUpdown = parseUpdownSlug(selectedSlug) != null;
        const biasSpec = isUpdown ? 'BIAS: UP|DOWN|NEUTRAL' : 'BIAS: ABOVE|BELOW|NEUTRAL';
        const engineLine = isUpdown
          ? 'You are a real-time market context engine for UP/DOWN time-window markets.'
          : 'You are a real-time market context engine for ABOVE/BELOW price-to-beat markets.';
        const safeRolling = rollingCtxText.length > 4_500 ? `${rollingCtxText.slice(0, 4_500)}\n…(truncated)` : rollingCtxText;
        const safeAssistantCtx =
          assistantContext && assistantContext.length > 3_500
            ? `${assistantContext.slice(0, 3_500)}\n…(truncated)`
            : assistantContext;
        const prompt = [
          engineLine,
          'Return a compact update with this exact format (keep the whole reply short — under ~120 words):',
          biasSpec,
          'CONF: <0-100>% (integer)',
          'WHY: <one sentence>',
          'BULLETS:',
          '- <momentum>',
          '- <orderbook pressure>',
          isUpdown ? '- <window time / volatility>' : '- <distance / level interaction>',
          '- <risk / invalidation>',
          'Do not give trading instructions; keep it informational.',
          '',
          safeRolling,
        ].join('\n');

        const prior = autoThreadRef.current[selectedSlug] ?? [];
        const nextThread = [...prior, { role: 'user' as const, content: prompt }].slice(-6);
        autoThreadRef.current[selectedSlug] = nextThread;
        setAutoThreadBySlug((m) => ({ ...m, [selectedSlug]: nextThread }));

        const res = await assistantChat({
          messages: nextThread,
          context: safeAssistantCtx ? `${safeAssistantCtx}\n\n${safeRolling}` : safeRolling || undefined,
          max_tokens: 280,
        });
        if (isOk(res)) {
          const msg = res.data.message;
          pushAutoLine({ ts: Date.now(), kind: 'reply', text: msg });
          setAutoThreadBySlug((m) => ({
            ...m,
            [selectedSlug]: [...(m[selectedSlug] ?? nextThread), { role: 'assistant' as const, content: msg }].slice(-6),
          }));
          autoThreadRef.current[selectedSlug] = [
            ...(autoThreadRef.current[selectedSlug] ?? nextThread),
            { role: 'assistant' as const, content: msg },
          ].slice(-6);

          const biasMatch = msg.match(/BIAS:\\s*(ABOVE|BELOW|UP|DOWN|NEUTRAL)/i);
          const confMatch = msg.match(/CONF:\\s*(\\d{1,3})%/i);
          const whyMatch = msg.match(/WHY:\\s*(.+)/i);
          const bias = biasMatch ? biasMatch[1]!.toUpperCase() : '—';
          const confidence = confMatch ? Number(confMatch[1]) : null;
          const why = whyMatch ? whyMatch[1]!.trim() : '';
          setAutoBiasBySlug((m) => ({ ...m, [selectedSlug]: { bias, confidence, why } }));
        } else {
          pushAutoLine({ ts: Date.now(), kind: 'error', text: pretty(res) });
        }
      } finally {
        setAutoBusy(false);
      }
    };

    // fire once, then every 15s (market snapshot + rolling context → API assistant)
    void tick();
    const id = window.setInterval(() => void tick(), 15_000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [autoEnabled, assistantAvailable, assistantContext, autoBusy, books, pushAutoLine, rollingCtxText, selectedSlug]);

  async function openUpdownShortcut(asset: UpdownShortcutAsset, interval: UpdownInterval) {
    setError(null);
    setMarketsError(null);
    setShortcutBusy({ asset, interval });
    setLastShortcut({ asset, interval });
    try {
      const res = await marketsUpdownShortcut(asset, interval);
      if (!isOk(res)) {
        setMarketsError(pretty(res));
        return;
      }
      if (res.data.start && res.data.end) {
        setMarketsError(
          `${asset.toUpperCase()} ${interval} window: ${new Date(res.data.start).toLocaleTimeString()}–${new Date(res.data.end).toLocaleTimeString()} · slug ${res.data.slug}`,
        );
      } else {
        setMarketsError(null);
      }
      // 5m: open prior round (PTB = previous window open, less noisy at the roll). 15m: open the live window from the API.
      const slugToOpen =
        interval === '15m' ? res.data.slug : (nextUpdownSlug(res.data.slug, -1) ?? res.data.slug);
      await loadMarket(slugToOpen);
    } finally {
      setShortcutBusy(null);
    }
  }

  async function runSearch() {
    setError(null);
    setMarketsError(null);
    const term = q.trim();
    if (!term) {
      const list = await marketsList(25);
      if (isOk(list)) {
        const rows = asMarketRows(list.data);
        setMarkets(rows);
        if (rows.length === 0) setMarketsError('No markets in this page of results.');
      } else {
        setMarkets([]);
        setMarketsError(pretty(list));
      }
      return;
    }
    const res = await marketsSearch(term, 25);
    if (isOk(res)) {
      const rows = asMarketRows(res.data);
      if (rows.length === 0) {
        const asRef = normalizeMarketLookupRef(term);
        if (asRef) {
          setMarketsError(null);
          const opened = await loadMarket(asRef);
          if (opened.ok) setMarkets([opened.data]);
          return;
        }
        setMarkets([]);
        setMarketsError(`No matches for “${term}”. Try a shorter query or paste a slug from polymarket.com.`);
        return;
      }
      setMarkets(rows);
      setMarketsError(null);
      if (rows.length === 1) {
        const only = pickMarketSlug(rows[0]);
        if (only) {
          const opened = await loadMarket(only);
          if (opened.ok) setMarkets(rows);
        }
      }
    } else {
      setMarkets([]);
      setMarketsError(pretty(res));
    }
  }

  return (
    <div
      className={`min-h-full bg-zinc-950 bg-[radial-gradient(100%_60%_at_50%_-10%,rgba(99,102,241,0.08),transparent_52%),linear-gradient(180deg,#0b0b0f_0%,#09090b_45%,#060608_100%)] font-sans text-zinc-200 antialiased ${
        tradePanelOpen ? 'md:pr-[380px] 2xl:pr-[400px]' : ''
      } transition-[padding] duration-200`}
    >
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="rounded-2xl border border-zinc-800/50 bg-zinc-900/20 px-5 py-5 shadow-lg shadow-black/20 ring-1 ring-white/[0.03] backdrop-blur-sm sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-50 sm:text-[1.65rem]">Polymarket order flow</h1>
              <p className="mt-1 text-sm text-zinc-500">Live CLOB ladders and a small assistant for reading the book.</p>
              <p className="mt-2 max-w-2xl text-[12px] leading-relaxed text-zinc-500">{STREAM_ATTRIBUTION_LINE}</p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setTradePanelOpen(true)}
                className="min-h-[34px] rounded-full border border-amber-500/35 bg-zinc-950/70 px-4 text-[12px] font-black tracking-wide text-amber-100 shadow-lg shadow-black/20 ring-1 ring-white/[0.04] transition-colors hover:bg-zinc-900/80"
                title={
                  !effectiveTradeReady
                    ? 'Open trade (market not ready yet)'
                    : effectiveTradeEnabled
                      ? 'Open trade'
                      : 'Open trade (tokens not resolved yet)'
                }
              >
                Trade
              </button>
              <button
                type="button"
                onClick={() => setPositionsPanelOpen(true)}
                className="min-h-[34px] rounded-full border border-cyan-600/35 bg-zinc-950/70 px-4 text-[12px] font-black tracking-wide text-cyan-100 shadow-lg shadow-black/20 ring-1 ring-white/[0.04] transition-colors hover:bg-zinc-900/80"
                title="Global positions (paper) — X exit row, Shift+X close all"
              >
                Positions
              </button>
              <div className="rounded-full border border-zinc-700/40 bg-zinc-950/50 px-3 py-1.5 font-mono text-[11px] leading-snug text-zinc-400">
                {apiHealth}
              </div>
            </div>
          </div>
          <p className="mt-4 max-w-3xl text-sm leading-relaxed text-zinc-500">
            The UI proxies to a local API on <span className="rounded-md border border-zinc-700/50 bg-zinc-950/60 px-1.5 py-0.5 font-mono text-zinc-400">8787</span>
            . With the <code className="rounded-md border border-zinc-700/50 bg-zinc-950/60 px-1.5 py-0.5 font-mono text-[13px] text-zinc-300">polymarket</code> CLI on your PATH it shells out; otherwise it uses Gamma + CLOB over HTTP. Run{' '}
            <code className="rounded-md border border-zinc-700/50 bg-zinc-950/60 px-1.5 py-0.5 font-mono text-[13px] text-zinc-300">npm run dev</code> from the repo root. Deep link example:{' '}
            <code className="rounded-md border border-zinc-700/50 bg-zinc-950/60 px-1.5 py-0.5 font-mono text-[13px] text-zinc-300">?slug=btc-updown-15m-1776380400</code> — full Polymarket URLs work in the slug field too.
          </p>
        </header>

        <div className="mt-8 flex flex-col gap-5 xl:grid xl:grid-cols-12 xl:items-start xl:gap-6">
          <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/40 p-5 shadow-lg shadow-black/25 ring-1 ring-white/[0.02] backdrop-blur-sm xl:col-span-3">
            <div className="mb-4 flex flex-col gap-2">
              <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Open market</div>
              <div className="flex flex-wrap gap-2">
                {(['btc', 'eth', 'sol'] as const).map((asset) => {
                  const busy = shortcutBusy?.asset === asset && shortcutBusy.interval === '5m';
                  return (
                    <button
                      key={`5m-${asset}`}
                      type="button"
                      disabled={shortcutBusy !== null}
                      onClick={() => void openUpdownShortcut(asset, '5m')}
                      className={`min-w-[4.5rem] flex-1 rounded-xl border px-3 py-2.5 text-center text-sm font-semibold uppercase tracking-wide transition-colors disabled:cursor-wait disabled:opacity-50 sm:flex-none ${
                        asset === 'btc'
                          ? 'border-amber-700/50 bg-amber-950/30 text-amber-100 hover:bg-amber-950/50'
                          : asset === 'eth'
                            ? 'border-indigo-700/50 bg-indigo-950/30 text-indigo-100 hover:bg-indigo-950/50'
                            : 'border-violet-700/50 bg-violet-950/30 text-violet-100 hover:bg-violet-950/50'
                      }`}
                    >
                      {busy ? '…' : asset}
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] leading-snug text-zinc-600">5m Up/Down — taps resolve the current Gamma slug (live window).</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {(['btc', 'eth', 'sol'] as const).map((asset) => {
                  const busy = shortcutBusy?.asset === asset && shortcutBusy.interval === '15m';
                  return (
                    <button
                      key={`15m-${asset}`}
                      type="button"
                      disabled={shortcutBusy !== null}
                      onClick={() => void openUpdownShortcut(asset, '15m')}
                      className={`min-w-[4.5rem] flex-1 rounded-xl border px-3 py-2.5 text-center text-sm font-semibold uppercase tracking-wide transition-colors disabled:cursor-wait disabled:opacity-50 sm:flex-none ${
                        asset === 'btc'
                          ? 'border-amber-700/50 bg-amber-950/30 text-amber-100 hover:bg-amber-950/50'
                          : asset === 'eth'
                            ? 'border-indigo-700/50 bg-indigo-950/30 text-indigo-100 hover:bg-indigo-950/50'
                            : 'border-violet-700/50 bg-violet-950/30 text-violet-100 hover:bg-violet-950/50'
                      }`}
                    >
                      {busy ? '…' : `${asset} 15m`}
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] leading-snug text-zinc-600">15m Up/Down — same assets, 15-minute windows.</p>
              <div className="flex gap-2">
                <input
                  value={slugInput}
                  onChange={(e) => setSlugInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void loadMarket(slugInput.trim());
                  }}
                  placeholder="Slug, id, or polymarket.com/event/…"
                  className="w-full rounded-xl border border-zinc-700/50 bg-zinc-900/35 px-3 py-2.5 text-sm text-zinc-100 outline-none ring-indigo-500/0 transition-shadow placeholder:text-zinc-600 focus:border-indigo-500/40 focus:ring-2 focus:ring-indigo-500/20"
                />
                <button
                  type="button"
                  onClick={() => void loadMarket(slugInput.trim())}
                  className="shrink-0 rounded-xl border border-zinc-600/60 bg-zinc-800/80 px-4 py-2.5 text-sm font-medium text-zinc-100 shadow-sm transition-colors hover:border-zinc-500 hover:bg-zinc-700/90"
                >
                  Open
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSearch();
                }}
                placeholder="Search markets…"
                className="w-full rounded-xl border border-zinc-700/50 bg-zinc-900/35 px-3 py-2.5 text-sm text-zinc-100 outline-none ring-indigo-500/0 transition-shadow placeholder:text-zinc-600 focus:border-indigo-500/40 focus:ring-2 focus:ring-indigo-500/20"
              />
              <button
                type="button"
                onClick={() => void runSearch()}
                className="rounded-xl bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-950/40 transition-colors hover:bg-indigo-400"
              >
                Search
              </button>
            </div>

            <div className="mt-4 text-xs leading-relaxed text-zinc-500">Choose a row to load both token books.</div>
            {marketsError ? (
              <pre className="mt-3 overflow-auto rounded-xl border border-amber-800/30 bg-amber-950/15 p-3 text-xs leading-relaxed text-amber-100/90">{marketsError}</pre>
            ) : null}
            <div className="mt-3 max-h-[60vh] overflow-auto rounded-xl border border-zinc-800/50 bg-black/15 shadow-inner shadow-black/20">
              {markets.length === 0 ? (
                <div className="p-4 text-sm leading-relaxed text-zinc-500">No results yet. Search or paste a slug above.</div>
              ) : (
                <ul className="divide-y divide-zinc-800/40">
                  {markets.map((m, idx) => {
                    const obj = m && typeof m === 'object' ? (m as Record<string, unknown>) : null;
                    const slug = pickMarketSlug(m);
                    const label = String(obj?.question ?? obj?.title ?? obj?.slug ?? obj?.id ?? `Market ${idx + 1}`);
                    const active = selectedSlug === slug;
                    return (
                      <li key={slug ? `${slug}-${idx}` : `row-${idx}`}>
                        <button
                          type="button"
                          disabled={!slug}
                          className={`w-full px-3 py-2.5 text-left text-sm transition-colors hover:bg-zinc-800/35 disabled:cursor-not-allowed disabled:opacity-40 ${
                            active ? 'border-l-2 border-indigo-400 bg-indigo-950/15' : 'border-l-2 border-transparent'
                          }`}
                          onClick={() => void loadMarket(slug)}
                        >
                          <div className="truncate font-medium text-zinc-100">{label}</div>
                          <div className="truncate font-mono text-[11px] text-zinc-500">{slug || '— no slug/id'}</div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/40 p-5 shadow-lg shadow-black/25 ring-1 ring-white/[0.02] backdrop-blur-sm xl:col-span-7">
            <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/40 pb-3">
              <div className="text-[15px] font-semibold text-zinc-100">{mainTabTitle(mainTab)}</div>
              <div className="truncate rounded-md bg-zinc-900/50 px-2 py-0.5 font-mono text-xs text-zinc-400">{selectedSlug || '—'}</div>
              {booksLoading ? (
                <div className="rounded-full bg-indigo-500/15 px-2.5 py-0.5 text-xs font-medium text-indigo-200/90">Loading…</div>
              ) : null}

              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPositionsPanelOpen(true)}
                  className="min-h-[34px] rounded-xl border border-cyan-800/50 bg-cyan-950/20 px-3 text-[12px] font-black tracking-wide text-cyan-100 ring-1 ring-white/[0.04] transition-colors hover:bg-cyan-950/35"
                  title="Global positions (paper)"
                >
                  Positions
                </button>
                <button
                  type="button"
                  onClick={() => setTradePanelOpen(true)}
                  className={`min-h-[34px] rounded-xl border px-3 text-[12px] font-black tracking-wide ring-1 ring-white/[0.04] transition-colors ${
                    'border-zinc-700/70 bg-black/20 text-zinc-200 hover:bg-black/30'
                  }`}
                  title={
                    !effectiveTradeReady
                      ? 'Open trade (market not ready yet)'
                      : effectiveTradeEnabled
                        ? 'Open trade'
                        : 'Open trade (tokens not resolved yet)'
                  }
                >
                  Trade
                </button>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-x-0.5 gap-y-0 border-b border-zinc-800/80">
              <MainTabButton id="book" label="Book" active={mainTab === 'book'} onSelect={setMainTab} />
              <MainTabButton id="flowzones" label="Flow" title="Flow Zones" active={mainTab === 'flowzones'} onSelect={setMainTab} />
              <MainTabButton id="signals" label="Signals" active={mainTab === 'signals'} onSelect={setMainTab} />
              <MainTabButton id="tracking" label="Tracking" title="Positions + open orders + cash" active={mainTab === 'tracking'} onSelect={setMainTab} />
              <MainTabButton id="tradehistory" label="History" title="Trade history (paper + live log)" active={mainTab === 'tradehistory'} onSelect={setMainTab} />
              <MainTabButton id="dualptb" label="Dual PTB" title="Reference PTB continuation tab" active={mainTab === 'dualptb'} onSelect={setMainTab} />
              <MainTabButton id="threeup" label="3-up" title="BTC/ETH/SOL spot vs PTB (simultaneous)" active={mainTab === 'threeup'} onSelect={setMainTab} />
              <MainTabButton id="command" label="Command" title="Multi-market command tiles + command center" active={mainTab === 'command'} onSelect={setMainTab} />
              <MainTabButton id="unified" label="Unified" title="Unified PTB view (chart + panel)" active={mainTab === 'unified'} onSelect={setMainTab} />
              <MainTabButton id="multiscan" label="Multi" title="Multi-asset PTB scan" active={mainTab === 'multiscan'} onSelect={setMainTab} />
              <MainTabButton
                id="momentum"
                label="+4¢"
                title="Scalps: net +4¢ long scanner, READY/WAIT/AVOID, momentum & CATCH alerts — add slugs below"
                active={mainTab === 'momentum'}
                onSelect={setMainTab}
              />
              <MainTabButton id="watch" label="Watch" title="PTB Watch" active={mainTab === 'watch'} onSelect={setMainTab} />
              <MainTabButton id="workspace" label="Workspace" title="Drag + resize board" active={mainTab === 'workspace'} onSelect={setMainTab} />
              <MainTabButton id="assistant" label="Assistant" active={mainTab === 'assistant'} onSelect={setMainTab} />
              <MainTabButton id="raw" label="Raw" active={mainTab === 'raw'} onSelect={setMainTab} />
            </div>

            {isMarketClosed(marketJson) ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-800/25 bg-amber-950/15 px-3 py-2 text-xs text-amber-100/85">
                <div className="leading-relaxed">
                  {updownParsed ? (
                    <>
                      This {updownParsed.interval} window market looks <span className="font-medium text-amber-100">closed</span>, and CLOB books may not exist.
                      Tap the shortcut again to load the newest window.
                    </>
                  ) : (
                    <>
                      This market looks <span className="font-medium text-amber-100">closed</span>, and CLOB books may not exist.
                      Try opening a different slug or search.
                    </>
                  )}
                </div>
                {(updownParsed && isShortcutAsset(updownParsed.asset)) || lastShortcut ? (
                  <button
                    type="button"
                    onClick={() =>
                      void openUpdownShortcut(
                        (updownParsed && isShortcutAsset(updownParsed.asset) ? updownParsed.asset : lastShortcut!.asset) as UpdownShortcutAsset,
                        (updownParsed?.interval ?? lastShortcut!.interval) as UpdownInterval,
                      )
                    }
                    className="rounded-lg border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-950/50"
                  >
                    Refresh {(updownParsed?.asset ?? lastShortcut!.asset).toUpperCase()} {updownParsed?.interval ?? lastShortcut!.interval}
                  </button>
                ) : null}
              </div>
            ) : updownBehindBySec != null && updownParsed != null && updownBehindBySec >= updownParsed.stepSec ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-800/25 bg-amber-950/15 px-3 py-2 text-xs text-amber-100/85">
                <div className="leading-relaxed">
                  You’re viewing an older {updownParsed.interval} window (behind by <span className="font-mono">{Math.round(updownBehindBySec / 60)}m</span>).
                  Jump to the live window.
                </div>
                <div className="flex gap-2">
                  {nextUpdownSlug(selectedSlug, -1) ? (
                    <button
                      type="button"
                      onClick={() => void loadMarket(nextUpdownSlug(selectedSlug, -1)!)}
                      className="rounded-lg border border-zinc-700/50 bg-zinc-900/30 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-900/50"
                    >
                      Prev
                    </button>
                  ) : null}
                  {updownParsed && isShortcutAsset(updownParsed.asset) ? (
                    <button
                      type="button"
                      onClick={() => void openUpdownShortcut(updownParsed.asset as UpdownShortcutAsset, updownParsed.interval)}
                      className="rounded-lg border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-950/50"
                    >
                      Jump to live
                    </button>
                  ) : null}
                  {nextUpdownSlug(selectedSlug, 1) ? (
                    <button
                      type="button"
                      onClick={() => void loadMarket(nextUpdownSlug(selectedSlug, 1)!)}
                      className="rounded-lg border border-zinc-700/50 bg-zinc-900/30 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-900/50"
                    >
                      +{updownParsed.stepSec}s
                    </button>
                  ) : null}
                </div>
              </div>
            ) : marketEndsInMs != null && marketEndsInMs < -5_000 ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-800/25 bg-amber-950/15 px-3 py-2 text-xs text-amber-100/85">
                <div className="leading-relaxed">
                  This window likely ended already. Load the next{' '}
                  <span className="font-mono">+{updownParsed?.stepSec ?? 300}s</span> market for the live book.
                </div>
                <div className="flex gap-2">
                  {nextUpdownSlug(selectedSlug, -1) ? (
                    <button
                      type="button"
                      onClick={() => void loadMarket(nextUpdownSlug(selectedSlug, -1)!)}
                      className="rounded-lg border border-zinc-700/50 bg-zinc-900/30 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-900/50"
                    >
                      Prev
                    </button>
                  ) : null}
                  {nextUpdownSlug(selectedSlug, 1) ? (
                    <button
                      type="button"
                      onClick={() => void loadMarket(nextUpdownSlug(selectedSlug, 1)!)}
                      className="rounded-lg border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-950/50"
                    >
                      Next
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {updownParsed ? (
              <div className="mt-3 rounded-xl border border-zinc-800/60 bg-zinc-950/35 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[11px] font-semibold text-zinc-300">
                    5-minute markers
                    <span className="ml-2 font-mono text-zinc-500">({updownParsed.asset.toUpperCase()} {updownParsed.interval})</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setUpdownPickerOpen((v) => !v)}
                    className="rounded-lg border border-zinc-700/60 bg-black/20 px-2.5 py-1.5 text-[11px] font-bold text-zinc-200 hover:bg-black/30"
                    title="Jump to an exact 5m/15m window boundary"
                  >
                    {updownPickerOpen ? 'Hide' : 'Choose window'}
                  </button>
                </div>

                {updownPickerOpen ? (
                  <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-6">
                    {updownPickerItems.map((it) => (
                      <button
                        key={it.slug}
                        type="button"
                        onClick={() => {
                          setUpdownPickerOpen(false);
                          void loadMarket(it.slug);
                        }}
                        className={`rounded-lg border px-2 py-2 text-[11px] font-semibold transition-colors ${
                          it.slug === selectedSlug
                            ? 'border-emerald-600/60 bg-emerald-950/25 text-emerald-100'
                            : 'border-zinc-800/70 bg-black/15 text-zinc-300 hover:bg-black/25'
                        }`}
                        title={it.slug}
                      >
                        {it.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {tokenIds.length === 0 && mainTab !== 'watch' && mainTab !== 'momentum' && mainTab !== 'tradehistory' ? (
              <div className="mt-4 text-sm leading-relaxed text-zinc-500">Select a market to load token ids and ladders.</div>
            ) : null}

            {error ? (
              <pre className="mt-4 overflow-auto rounded-xl border border-red-800/30 bg-red-950/15 p-3 text-xs leading-relaxed text-red-200/90">{error}</pre>
            ) : null}

            {mainTab === 'book' ? (
              <div className="mt-5">
                <div className="mb-4 rounded-2xl border border-zinc-800/40 bg-zinc-900/20 p-3 ring-1 ring-white/[0.02]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Outcome mids</div>
                      <button
                        type="button"
                        onClick={() => setMainTab('momentum')}
                        className="rounded-md border border-amber-800/50 bg-amber-950/30 px-2 py-0.5 text-[10px] font-semibold text-amber-100 hover:bg-amber-950/50"
                        title="Net +4¢ scalp scanner, READY/WAIT verdict, alerts"
                      >
                        +4¢ scalps →
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <TradeSegmentedControl
                        value={flowMode}
                        onChange={(v) => setFlowMode(v as 'price' | 'flow')}
                        options={[
                          { value: 'price', label: 'Price' },
                          { value: 'flow', label: 'Order flow' },
                        ]}
                      />
                      <button
                        type="button"
                        onClick={() => setChartEnabled((v) => !v)}
                        className={`rounded-lg border px-3 py-1.5 text-[11px] font-semibold transition-colors ${
                          chartEnabled
                            ? 'border-emerald-700/40 bg-emerald-950/20 text-emerald-100 hover:bg-emerald-950/35'
                            : 'border-zinc-700/50 bg-zinc-950/20 text-zinc-300 hover:bg-zinc-900/40'
                        }`}
                        title="Polls books every 5s when on"
                      >
                        {chartEnabled ? 'On' : 'Off'}
                      </button>
                    </div>
                  </div>
                  {books && books.length >= 2 ? (
                    <div className="mt-3">
                      {flowMode === 'price' ? (
                        <MomentumChart
                          title="Outcome mids (price momentum)"
                          aLabel={outcomeLabels[0] ?? 'A'}
                          aTone="up"
                          a={(chartSeriesBySlug[selectedSlug]?.[books[0]!.token] ?? []).slice(-120)}
                          bLabel={outcomeLabels[1] ?? 'B'}
                          bTone="down"
                          b={(chartSeriesBySlug[selectedSlug]?.[books[1]!.token] ?? []).slice(-120)}
                          lastUpdateMs={booksFetchedAt}
                          priceToBeatUsd={ssrPriceToBeat}
                        />
                      ) : (
                        <OrderFlowChart
                          title={`Order flow (active: ${outcomeLabels[outcomeTab] ?? `Outcome ${outcomeTab + 1}`})`}
                          series={(flowSeriesBySlug[selectedSlug]?.[books[outcomeTab]!.token] ?? []).slice(-180)}
                          lastUpdateMs={booksFetchedAt}
                          priceToBeatUsd={ssrPriceToBeat}
                        />
                      )}
                    </div>
                  ) : (
                    <div className="mt-2 text-xs text-zinc-600">Load a two-outcome market to see the live sparkline.</div>
                  )}
                </div>
                {books && books.length > 1 ? (
                  <div className="mb-4 flex flex-wrap gap-1 rounded-xl bg-zinc-900/40 p-1 ring-1 ring-zinc-800/50">
                    {books.map((entry, idx) => {
                      const label = outcomeLabels[idx] ?? `Outcome ${idx + 1}`;
                      const active = outcomeTab === idx;
                      return (
                        <button
                          key={entry.token}
                          type="button"
                          onClick={() => setOutcomeTab(idx)}
                          className={`rounded-lg px-3 py-2 text-sm font-medium transition-all ${
                            active
                              ? 'bg-zinc-800 text-zinc-50 shadow-sm ring-1 ring-zinc-700/60'
                              : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {books && books[outcomeTab] ? (
                  <OutcomePane
                    entry={books[outcomeTab]!}
                    label={outcomeLabels[outcomeTab] ?? `Outcome ${outcomeTab + 1}`}
                    autoLines={autoLinesBySlug[selectedSlug] ?? []}
                    fetchedAt={booksFetchedAt}
                    market={marketJson}
                  />
                ) : tokenIds.length > 0 && !booksLoading && !error ? (
                  <div className="mt-4 text-sm leading-relaxed text-zinc-500">No book payload yet.</div>
                ) : null}
                <AboveBelowDashboard
                  market={marketJson}
                  books={books}
                  outcomeLabels={outcomeLabels}
                  flowSeriesForSlug={flowSeriesBySlug[selectedSlug] ?? null}
                  priceToBeat={ssrPriceToBeat}
                  refPrice={rtdsSpot}
                />
              </div>
            ) : null}

            {mainTab === 'momentum' ? (
              <MomentumAlertsTab
                currentSlug={selectedSlug}
                priceToBeatUsd={ssrPriceToBeat}
                onOpenInBook={(slug) => {
                  void loadMarket(slug);
                  setMainTab('book');
                }}
              />
            ) : null}

            {mainTab === 'watch' ? (
              <PtbWatchTab
                watchedSlugs={ptbWatchSlugs}
                onChangeWatchedSlugs={setPtbWatchSlugs}
                recentSlugs={ptbWatchRecentSlugs}
                currentSlug={selectedSlug}
                onOpenInBook={(slug) => {
                  void loadMarket(slug);
                }}
              />
            ) : null}

            {mainTab === 'workspace' ? (
              <WorkspaceTab
                currentSlug={selectedSlug}
                market={marketJson}
                books={books}
                outcomeLabels={outcomeLabels}
                flowSeriesForSlug={flowSeriesBySlug[selectedSlug] ?? null}
                booksFetchedAt={booksFetchedAt}
                priceToBeatUsd={ssrPriceToBeat}
                endsInMs={marketEndsInMs}
                onOpenInBook={(slug) => {
                  void loadMarket(slug);
                  setMainTab('book');
                }}
              />
            ) : null}

            {mainTab === 'flowzones' ? (
              <div className="mt-5">
                <FlowZonesTab
                  market={marketJson}
                  books={books}
                  outcomeLabels={outcomeLabels}
                  flowSeriesForSlug={flowSeriesBySlug[selectedSlug] ?? null}
                  booksFetchedAt={booksFetchedAt}
                  priceToBeatUsd={ssrPriceToBeat}
                  endsInMs={marketEndsInMs}
                />
              </div>
            ) : null}

            {mainTab === 'signals' ? (
              <div className="mt-5">
                <SignalsPtbOnly
                  market={marketJson}
                  books={books}
                  outcomeLabels={outcomeLabels}
                  priceToBeat={ssrPriceToBeat}
                  spot={spotSeriesBySlug[selectedSlug] ?? []}
                  spotLastUpdateMs={rtdsTickAt}
                  probUp={signalsProbMids.up}
                  probDown={signalsProbMids.down}
                  probLastUpdateMs={booksFetchedAt}
                  flowSeriesForSlug={flowSeriesBySlug[selectedSlug] ?? null}
                  endsInMs={marketEndsInMs}
                  booksFetchedAt={booksFetchedAt}
                  spotStreamEligible={updownParsed != null}
                />
                <p className="mt-3 text-center text-[11px] text-zinc-600">
                  Book tab: order flow, ladders, and above/below context. Assistant tab: chat + digest.
                </p>
              </div>
            ) : null}

            {mainTab === 'tracking' ? (
              <TrackingTab upToken={effectiveTradeContext.upToken} downToken={effectiveTradeContext.downToken} />
            ) : null}

            {mainTab === 'tradehistory' ? (
              <div className="mt-5">
                <TradeHistoryTab />
              </div>
            ) : null}

            {mainTab === 'multiscan' ? (
              <div className="mt-5">
                <PtbMultiAssetGrid
                  rows={multiScanRows}
                  onOpenSlug={(slug) => {
                    void loadMarket(slug);
                    setMainTab('dualptb');
                  }}
                  onAddMarkets={() => setMainTab('watch')}
                />
              </div>
            ) : null}

            {mainTab === 'threeup' ? (
              <div className="mt-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-zinc-200">BTC / ETH / SOL · spot vs PTB</div>
                  <div className="flex gap-1 rounded-xl border border-zinc-800/60 bg-black/20 p-1">
                    <button
                      type="button"
                      onClick={() => setThreeUpInterval('5m')}
                      className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold ${
                        threeUpInterval === '5m' ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      5m
                    </button>
                    <button
                      type="button"
                      onClick={() => setThreeUpInterval('15m')}
                      className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold ${
                        threeUpInterval === '15m' ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      15m
                    </button>
                  </div>
                </div>
                <PtbThreeUp
                  rows={[
                    {
                      label: 'BTC/USD',
                      spot: spotBySymbol['btc/usd'] ?? [],
                      ptb: threeUpMeta.btc?.ptb ?? null,
                      endsInMs: threeUpMeta.btc?.endsInMs ?? null,
                      lastUpdateMs: (spotBySymbol['btc/usd'] ?? []).slice(-1)[0]?.t ?? null,
                    },
                    {
                      label: 'ETH/USD',
                      spot: spotBySymbol['eth/usd'] ?? [],
                      ptb: threeUpMeta.eth?.ptb ?? null,
                      endsInMs: threeUpMeta.eth?.endsInMs ?? null,
                      lastUpdateMs: (spotBySymbol['eth/usd'] ?? []).slice(-1)[0]?.t ?? null,
                    },
                    {
                      label: 'SOL/USD',
                      spot: spotBySymbol['sol/usd'] ?? [],
                      ptb: threeUpMeta.sol?.ptb ?? null,
                      endsInMs: threeUpMeta.sol?.endsInMs ?? null,
                      lastUpdateMs: (spotBySymbol['sol/usd'] ?? []).slice(-1)[0]?.t ?? null,
                    },
                  ]}
                />
              </div>
            ) : null}

            {mainTab === 'command' ? (
              <div className="mt-5 space-y-3">
                <SmartMoneyPaperPanel />
                <MultiMarketCommandView
                  intervalLabel={threeUpInterval}
                  rows={
                    [
                      {
                        key: 'btc',
                        label: `BTC ${threeUpInterval}`,
                        slug: _threeUpSlugs.btc ?? '',
                        spot: spotBySymbol['btc/usd'] ?? [],
                        ptb: threeUpMeta.btc?.ptb ?? null,
                        endsInMs: threeUpMeta.btc?.endsInMs ?? null,
                        lastUpdateMs: (spotBySymbol['btc/usd'] ?? []).slice(-1)[0]?.t ?? null,
                      },
                      {
                        key: 'eth',
                        label: `ETH ${threeUpInterval}`,
                        slug: _threeUpSlugs.eth ?? '',
                        spot: spotBySymbol['eth/usd'] ?? [],
                        ptb: threeUpMeta.eth?.ptb ?? null,
                        endsInMs: threeUpMeta.eth?.endsInMs ?? null,
                        lastUpdateMs: (spotBySymbol['eth/usd'] ?? []).slice(-1)[0]?.t ?? null,
                      },
                      {
                        key: 'sol',
                        label: `SOL ${threeUpInterval}`,
                        slug: _threeUpSlugs.sol ?? '',
                        spot: spotBySymbol['sol/usd'] ?? [],
                        ptb: threeUpMeta.sol?.ptb ?? null,
                        endsInMs: threeUpMeta.sol?.endsInMs ?? null,
                        lastUpdateMs: (spotBySymbol['sol/usd'] ?? []).slice(-1)[0]?.t ?? null,
                      },
                      {
                        key: 'matic',
                        label: `MATIC ${threeUpInterval}`,
                        slug: '',
                        spot: [],
                        ptb: null,
                        endsInMs: null,
                        lastUpdateMs: null,
                        disabled: true,
                      },
                      {
                        key: 'alt',
                        label: `ALT ${threeUpInterval}`,
                        slug: '',
                        spot: [],
                        ptb: null,
                        endsInMs: null,
                        lastUpdateMs: null,
                        disabled: true,
                      },
                    ] as MultiMarketRow[]
                  }
                  selectedKey={commandSelected}
                  onSelectKey={setCommandSelected}
                  onFocusMarket={(slug) => {
                    if (!slug) return;
                    void loadMarket(slug);
                    setMainTab('dualptb');
                  }}
                  onOpenTradeDock={({ slug, lane }) => {
                    if (slug) void loadMarket(slug);
                    // Let the panel auto-bind to the currently loaded market unless user locks manually.
                    setGlobalTradeLocked(false);
                    setGlobalTradeLane(lane);
                    setTradePanelOpen(true);
                  }}
                />
              </div>
            ) : null}

            {mainTab === 'unified' ? (
              <div className="mt-5">
                <UnifiedPtbView
                  market={marketJson}
                  books={books}
                  outcomeLabels={outcomeLabels}
                  priceToBeat={ssrPriceToBeat}
                  spot={spotSeriesBySlug[selectedSlug] ?? []}
                  spotLastUpdateMs={rtdsTickAt}
                  probUp={signalsProbMids.up}
                  probDown={signalsProbMids.down}
                  probLastUpdateMs={booksFetchedAt}
                  flowSeriesForSlug={flowSeriesBySlug[selectedSlug] ?? null}
                  booksFetchedAt={booksFetchedAt}
                  endsInMs={marketEndsInMs}
                  spotStreamEligible={updownParsed != null}
                  uiVariant={updownParsed != null ? 'polymarket' : 'default'}
                  rightPanel={
                    effectiveTradeEnabled ? (
                      updownParsed != null ? (
                        <PolySimulatorTradePanel
                          upLabel={effectiveTradeContext.upLabel}
                          downLabel={effectiveTradeContext.downLabel}
                          upMid={signalsProbMids.up.length ? (signalsProbMids.up[signalsProbMids.up.length - 1]!.v ?? null) : null}
                          downMid={signalsProbMids.down.length ? (signalsProbMids.down[signalsProbMids.down.length - 1]!.v ?? null) : null}
                        />
                      ) : (
                        <div className="rounded-[28px] border border-zinc-800/70 bg-[#0d1219] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.25)] ring-1 ring-white/[0.03]">
                          <div className="flex items-center justify-between gap-3 border-b border-zinc-800/50 pb-3">
                            <div className="min-w-0">
                              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Trade</div>
                              <div className="truncate text-[13px] font-semibold text-zinc-100">
                                {effectiveTradeContext.question || effectiveTradeContext.slug || 'Market'}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setTradePanelOpen(true);
                              }}
                              className="shrink-0 rounded-xl border border-zinc-700/60 bg-black/20 px-3 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-black/30"
                              title="Open full trade dock"
                            >
                              Dock
                            </button>
                          </div>

                          <div className="mt-3">
                            <SignalsTradePanel
                              marketSlug={effectiveTradeContext.slug}
                              marketQuestion={effectiveTradeContext.question}
                              upLabel={effectiveTradeContext.upLabel}
                              downLabel={effectiveTradeContext.downLabel}
                              upToken={effectiveTradeContext.upToken}
                              downToken={effectiveTradeContext.downToken}
                              upMid={signalsProbMids.up.length ? (signalsProbMids.up[signalsProbMids.up.length - 1]!.v ?? null) : null}
                              downMid={signalsProbMids.down.length ? (signalsProbMids.down[signalsProbMids.down.length - 1]!.v ?? null) : null}
                              bookMidUp={tradePanelBookMids.up}
                              bookMidDown={tradePanelBookMids.down}
                              bookTouchUp={tradePanelBookTouch.up}
                              bookTouchDown={tradePanelBookTouch.down}
                              bookUp={books && globalUpDown ? books[globalUpDown.up]?.book ?? null : null}
                              bookDown={books && globalUpDown ? books[globalUpDown.down]?.book ?? null : null}
                              lane={globalTradeLane}
                              onLaneChange={onGlobalTradeLaneChange}
                              visualStyle="sidebar"
                            />
                          </div>
                        </div>
                      )
                    ) : null
                  }
                />
              </div>
            ) : null}

            {mainTab === 'dualptb' ? (
              <div className="mt-5">
                <DualPtbReferenceTab
                  market={marketJson}
                  books={books}
                  outcomeLabels={outcomeLabels}
                  priceToBeat={ssrPriceToBeat}
                  spot={spotSeriesBySlug[selectedSlug] ?? []}
                  spotLastUpdateMs={rtdsTickAt}
                  probUp={signalsProbMids.up}
                  probDown={signalsProbMids.down}
                  probLastUpdateMs={booksFetchedAt}
                  endsInMs={marketEndsInMs}
                  spotStreamEligible={updownParsed != null}
                />
              </div>
            ) : null}

            {mainTab === 'assistant' ? (
              <div className="mt-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-800/50 bg-zinc-900/20 p-4 ring-1 ring-white/[0.02]">
                  <div>
                    <div className="text-sm font-semibold text-zinc-100">Auto context</div>
                    <div className="mt-1 text-xs leading-relaxed text-zinc-500">
                      When enabled, sends a trimmed snapshot every <span className="font-mono text-zinc-400">15s</span> (small context + short
                      reply budget) so auto-updates stay quicker than a full manual chat.
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={!assistantAvailable || autoBusy}
                    onClick={() => setAutoEnabled((v) => !v)}
                    className={`rounded-xl px-4 py-2 text-xs font-semibold transition-colors disabled:opacity-50 ${
                      autoEnabled
                        ? 'border border-emerald-700/40 bg-emerald-950/30 text-emerald-100 hover:bg-emerald-950/50'
                        : 'border border-zinc-700/50 bg-zinc-900/30 text-zinc-200 hover:bg-zinc-900/50'
                    }`}
                  >
                    {autoEnabled ? (autoBusy ? 'Auto: on…' : 'Auto: on') : 'Auto: off'}
                  </button>
                </div>

                <OrderFlowAssistant key={selectedSlug} apiAvailable={assistantAvailable} context={assistantContext} />
              </div>
            ) : null}

            {mainTab === 'raw' ? (
              <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div>
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Market</div>
                  <pre className="max-h-[55vh] overflow-auto rounded-xl border border-zinc-800/50 bg-black/25 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
                    {marketJson ? pretty(marketJson) : '—'}
                  </pre>
                </div>
                <div>
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Books</div>
                  <pre className="max-h-[55vh] overflow-auto rounded-xl border border-zinc-800/50 bg-black/25 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
                    {books ? pretty(books) : '—'}
                  </pre>
                </div>
              </div>
            ) : null}
          </div>

          <div className="xl:col-span-2">
            <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/40 p-5 shadow-lg shadow-black/25 ring-1 ring-white/[0.02] backdrop-blur-sm">
              <div className="text-[15px] font-semibold text-zinc-100">Quick actions</div>
              <div className="mt-2 text-xs leading-relaxed text-zinc-500">
                Use the tabs in the Book panel. This right column is kept minimal to avoid the “everything stacked” feel.
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setMainTab('book')}
                  className="rounded-xl border border-zinc-700/50 bg-zinc-900/30 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-900/50"
                >
                  Book
                </button>
                <button
                  type="button"
                  onClick={() => setMainTab('signals')}
                  className="rounded-xl border border-zinc-700/50 bg-zinc-900/30 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-900/50"
                >
                  Signals
                </button>
                <button
                  type="button"
                  onClick={() => setMainTab('tradehistory')}
                  className="rounded-xl border border-zinc-700/50 bg-zinc-900/30 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-900/50"
                >
                  History
                </button>
                <button
                  type="button"
                  onClick={() => setMainTab('dualptb')}
                  className="rounded-xl border border-zinc-700/50 bg-zinc-900/30 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-900/50"
                >
                  Dual PTB
                </button>
                <button
                  type="button"
                  onClick={() => setMainTab('momentum')}
                  className="rounded-xl border border-zinc-700/50 bg-zinc-900/30 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-900/50"
                >
                  +4¢ scalps
                </button>
                <button
                  type="button"
                  onClick={() => setMainTab('watch')}
                  className="rounded-xl border border-zinc-700/50 bg-zinc-900/30 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-900/50"
                >
                  PTB Watch
                </button>
                <button
                  type="button"
                  onClick={() => setMainTab('assistant')}
                  className="rounded-xl border border-zinc-700/50 bg-zinc-900/30 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-900/50"
                >
                  Assistant
                </button>
                <button
                  type="button"
                  onClick={() => setMainTab('raw')}
                  className="rounded-xl border border-zinc-700/50 bg-zinc-900/30 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-900/50"
                >
                  Raw
                </button>
              </div>
            </div>
          </div>
        </div>

        <TradeSlidePanel
          open={tradePanelOpen}
          onClose={() => setTradePanelOpen(false)}
          title={effectiveTradeContext.question || effectiveTradeContext.slug || 'Market'}
        >
          <div className="space-y-2">
            <details className="rounded-2xl border border-zinc-800/60 bg-zinc-950/30" open={false}>
              <summary className="cursor-pointer select-none px-3 py-2.5 text-[11px] font-semibold text-zinc-400 hover:text-zinc-200 [&::-webkit-details-marker]:hidden">
                <span className="mr-1 text-zinc-600" aria-hidden>
                  ▸
                </span>
                Markets · pin
              </summary>
              <div className="border-t border-zinc-800/50 px-3 py-3 space-y-2">
                <TradeSessionTabsBar
                  tabs={tradeSessionTabs}
                  activeId={activeTradeSessionTabId}
                  onSelect={onSelectTradeSessionTab}
                  onAdd={onAddTradeSessionTab}
                  onClose={onCloseTradeSessionTab}
                />
                <button
                  type="button"
                  onClick={() => {
                    setGlobalTradeLocked((v) => {
                      const next = !v;
                      if (next) setGlobalTradeContext(currentTradeContext);
                      return next;
                    });
                  }}
                  className={`min-h-[40px] w-full rounded-xl border px-3.5 text-[11px] font-semibold tracking-wide transition-colors ${
                    globalTradeLocked
                      ? 'border-amber-500/50 bg-amber-500/15 text-amber-50 hover:bg-amber-500/20'
                      : 'border-zinc-600/60 bg-zinc-950/50 text-zinc-200 hover:border-zinc-500/60 hover:bg-zinc-900/60'
                  }`}
                  title={
                    globalTradeLocked
                      ? 'Unpin — panel will follow whichever market you load next'
                      : 'Pin — keep trading this market even if you open another slug in the background'
                  }
                >
                  {globalTradeLocked ? 'Pinned (click to unpin)' : 'Pin current market'}
                </button>
              </div>
            </details>

            {effectiveTradeEnabled ? (
              <SignalsTradePanel
                marketSlug={effectiveTradeContext.slug}
                marketQuestion={effectiveTradeContext.question}
                upLabel={effectiveTradeContext.upLabel}
                downLabel={effectiveTradeContext.downLabel}
                upToken={effectiveTradeContext.upToken}
                downToken={effectiveTradeContext.downToken}
                upMid={signalsProbMids.up.length ? (signalsProbMids.up[signalsProbMids.up.length - 1]!.v ?? null) : null}
                downMid={signalsProbMids.down.length ? (signalsProbMids.down[signalsProbMids.down.length - 1]!.v ?? null) : null}
                bookMidUp={tradePanelBookMids.up}
                bookMidDown={tradePanelBookMids.down}
                bookTouchUp={tradePanelBookTouch.up}
                bookTouchDown={tradePanelBookTouch.down}
                lane={globalTradeLane}
                onLaneChange={onGlobalTradeLaneChange}
                visualStyle="slide"
              />
            ) : !effectiveTradeReady ? (
              <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/40 p-4 text-[13px] leading-relaxed text-zinc-400">
                <p className="font-medium text-zinc-300">Almost there</p>
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-zinc-500">
                  <li>Use the shortcuts or search to open a market.</li>
                  <li>Wait until the order book finishes loading.</li>
                  <li>Then use Trade again — the panel unlocks automatically.</li>
                </ol>
              </div>
            ) : (
              <div className="rounded-2xl border border-amber-900/25 bg-amber-950/10 p-4 text-[13px] leading-relaxed text-amber-100/85">
                <p className="font-medium text-amber-100">Tokens not ready</p>
                <p className="mt-2 text-amber-100/75">
                  This market loaded, but we still need both outcome tokens (usually a two-sided Yes/No or Up/Down market). Try another slug, or wait for books to populate.
                </p>
                <p className="mt-2 text-[12px] text-amber-200/60">
                  For <span className="font-medium text-amber-100/90">live</span> orders, your API needs{' '}
                  <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[11px] text-amber-200/90">POLYMARKET_PRIVATE_KEY</code>{' '}
                  configured — Paper mode still works for practice.
                </p>
              </div>
            )}
          </div>
        </TradeSlidePanel>

        <PositionsCommandPanel
          open={positionsPanelOpen}
          onClose={() => setPositionsPanelOpen(false)}
          selectedSlug={selectedSlug}
          booksFetchedAt={booksFetchedAt}
          onNavigate={(slug, lane) => {
            void loadMarket(slug);
            setGlobalTradeLane(lane);
            setMainTab('dualptb');
          }}
        />
      </div>
    </div>
  );
}

export default App;
