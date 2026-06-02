import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
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
import { AboveBelowDashboard } from './AboveBelowDashboard';
const FlowZonesTab = lazy(() => import('./FlowZonesTab').then((m) => ({ default: m.FlowZonesTab })));
import { SignalsPtbOnly } from './SignalsPtbOnly';
import { applyPaperSettlementForLoadedMarket } from './paperTrading';
import { TradePanelBody, TradePanelShell } from './TradePanelBody';
import { SignalsTradePanel } from './SignalsTradePanel';
import { TradeSegmentedControl } from './tradeUi';
import { loadTradeUiPreferences, saveTradeUiPreferences } from './tradeUiPreferences';
import { priceToBeat, rtdsCrypto } from './lib/api';
import { pickMarketSlug } from './gammaMarketSlug';
import { TradeSlidePanel, TRADE_SLIDE_PANEL_WIDTH_PX } from './TradeSlidePanel';
const PositionsCommandPanel = lazy(() =>
  import('./PositionsCommandPanel').then((m) => ({ default: m.PositionsCommandPanel })),
);
const TradeHistoryTab = lazy(() => import('./TradeHistoryTab').then((m) => ({ default: m.TradeHistoryTab })));
import { shortTradeTabLabel, TradeSessionTabsBar, type TradeSessionTab } from './TradeSessionTabsBar';
import {
  BPX_SIGNALS_LANE_SYNC_EVENT,
  BPX_TRADE_PANEL_OPEN_EVENT,
  type BpxSignalsLaneSyncDetail,
} from './takeSignalDesk';
const PtbMultiAssetGrid = lazy(() => import('./PtbMultiAssetGrid').then((m) => ({ default: m.PtbMultiAssetGrid })));
import type { PtbMultiAssetRow } from './PtbMultiAssetGrid';
const TrackingTab = lazy(() => import('./TrackingTab').then((m) => ({ default: m.TrackingTab })));
import { STREAM_ATTRIBUTION_LINE } from './streamAttribution';
import { releaseOrphanPointerCapture } from './pointerCaptureSafety';
import type { SpotPoint } from './SpotLevelChart';
import { mergeSpotHistory } from './rtdsSpotMerge';
import { openClobMarketChannel, type ClobWsPriceChange } from './clobMarketChannel';
import { mergeWsBestBidAsk } from './stableBookDisplay';
import {
  bookIntelForAssistant,
  bookIntelLines,
  computeBookIntel,
  formatGammaVolumeLines,
  pickConditionId,
  pickGammaVolumeStats,
} from './bookIntel';
import { outcomeEntryExitHints } from './chartReadouts';
import { buildRollingContext, rollingContextText } from './contextSummary';
import {
  inferUpdownHintFromMarketJson,
  isUpdownDeskMarket,
  nextUpdownSlug,
  parseUpdownSlug,
  parseUpdownSlugWithHints,
  titledUpdownAssetFromSlug,
  type UpdownSlugHint,
} from './sixPackUpdownSlugs';
import { updownSlugToOpen } from './updownSlugToOpen';
import { BtcSpotPaperTest } from './BtcSpotPaperTest';
import { TradingViewBtcUsdtTab } from './TradingViewBtcUsdtTab';
import { PerpsCommandCenter } from './PerpsCommandCenter';
import { BinanceBtcUsdtMarketView } from './BinanceBtcUsdtMarketView';
import { useTradeAccountMode } from './useTradeAccountMode';
import { appendLiveMidSeries, lastPointMs, maxFeedMs, normalizeEpochMs } from './feedFreshness';

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function fetchFailedDetailLine(details: unknown): string {
  if (details == null) return '';
  if (typeof details === 'string') return details.trim();
  if (typeof details !== 'object') return String(details);
  const o = details as Record<string, unknown>;
  const message = typeof o.message === 'string' ? o.message.trim() : '';
  const hint = typeof o.hint === 'string' ? o.hint.trim() : '';
  return [message, hint].filter(Boolean).join(' — ');
}

function apiReachabilityHint(err: ApiErr): string {
  if (err.error !== 'fetch_failed') return '';
  const d = fetchFailedDetailLine(err.details);
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

function isShortcutAsset(asset: string): asset is UpdownShortcutAsset {
  return asset === 'btc' || asset === 'eth' || asset === 'sol' || asset === 'hype';
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
  const live = ageMs != null && ageMs < 60_000;
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
  | 'btc'
  | 'tvbtc'
  | 'perps'
  | 'multiscan'
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
    case 'btc':
      return 'BTC (paper)';
    case 'tvbtc':
      return 'BTC / USDT (spot)';
    case 'perps':
      return 'Perps command center';
    case 'multiscan':
      return 'Multi scan';
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
      className={`shrink-0 border-b-2 px-2.5 py-2 text-[13px] font-medium transition-colors ${
        active
          ? 'border-amber-500/75 text-zinc-100'
          : 'border-transparent text-zinc-500 hover:text-zinc-300'
      }`}
    >
      {label}
    </button>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, [query]);

  return matches;
}

function App() {
  const mobileLayout = useMediaQuery('(max-width: 767px)');
  const tradeAccountMode = useTradeAccountMode();
  const [apiHealth, setApiHealth] = useState<string>('Checking API…');
  const [q, setQ] = useState('');
  const [markets, setMarkets] = useState<unknown[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string>('');
  const [marketJson, setMarketJson] = useState<unknown | null>(null);
  const [books, setBooks] = useState<ClobBookEntry[] | null>(null);
  const [booksLoading, setBooksLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marketsError, setMarketsError] = useState<string | null>(null);
  const [marketsListLoading, setMarketsListLoading] = useState(true);
  const [slugInput, setSlugInput] = useState('');
  const [outcomeTab, setOutcomeTab] = useState(0);
  const [assistantAvailable, setAssistantAvailable] = useState(false);
  const [shortcutBusy, setShortcutBusy] = useState<{ asset: UpdownShortcutAsset; interval: UpdownInterval } | null>(null);
  const [lastShortcut, setLastShortcut] = useState<{ asset: UpdownShortcutAsset; interval: UpdownInterval } | null>(null);
  const [mainTab, setMainTab] = useState<MainTab>('signals');
  const [mobileMarketPanelOpen, setMobileMarketPanelOpen] = useState(false);
  /** Binance BTCUSDT spot — own book/flow/signals; pauses Polymarket CLOB WS/polls while active. */
  const [binanceSpotActive, setBinanceSpotActive] = useState(false);
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

  useEffect(() => {
    if (!mobileLayout) {
      setMobileMarketPanelOpen(false);
      return;
    }
    if (!selectedSlug.trim()) setMobileMarketPanelOpen(true);
  }, [mobileLayout, selectedSlug]);
  const [chartSeriesBySlug, setChartSeriesBySlug] = useState<Record<string, Record<string, SeriesPoint[]>>>({});
  const [flowSeriesBySlug, setFlowSeriesBySlug] = useState<Record<string, Record<string, BookSnapshot[]>>>({});
  const [flowMode, setFlowMode] = useState<'price' | 'flow'>('flow');
  const [ssrPriceToBeat, setSsrPriceToBeat] = useState<number | null>(null);
  /** API label for last successful PTB fetch (e.g. SSR vs bucket). */
  const [ssrPtbSource, setSsrPtbSource] = useState<string | null>(null);
  const [ptbError, setPtbError] = useState<string | null>(null);
  const [rtdsSpot, setRtdsSpot] = useState<number | null>(null);
  const [rtdsTickAt, setRtdsTickAt] = useState<number | null>(null);
  /** Wall-clock time of last successful RTDS HTTP poll (Chainlink `ts` can lag). */
  const [rtdsReceivedAt, setRtdsReceivedAt] = useState<number | null>(null);
  /** Last successful HTTP poll for the active RTDS symbol (WS may be quiet while polls still work). */
  const [rtdsLastPollMs, setRtdsLastPollMs] = useState<number | null>(null);
  const [rtdsError, setRtdsError] = useState<string | null>(null);
  /** RTDS `/api/rtds/crypto` `source` for the active underlying symbol (Chainlink vs fallback, etc.). */
  const [rtdsSpotFeedSource, setRtdsSpotFeedSource] = useState<string | null>(null);
  const [spotSeriesBySlug, setSpotSeriesBySlug] = useState<Record<string, SpotPoint[]>>({});
  /** RTDS spot: Chainlink slash-USD series plus Binance-mirrored USDT tickers (e.g. btc/usdt) — drives multi-asset scan + selected slug. */
  const [spotBySymbol, setSpotBySymbol] = useState<Record<string, SpotPoint[]>>({});
  const [watchMetaBySlug, setWatchMetaBySlug] = useState<Record<string, { ptb: number | null; endsInMs: number | null }>>({});
  const [now, setNow] = useState(() => Date.now());
  const spotBySymbolRef = useRef<Record<string, SpotPoint[]>>({});
  const selectedSlugRef = useRef<string>('');
  /** Bumped on every `loadMarket` — stale book/PTB fetches must not apply after a newer slug load. */
  const marketSyncGenRef = useRef(0);
  const marketBootRef = useRef(false);
  /** Auto-retry count when slug is set but `markets/get` failed (Gamma blip). */
  const marketLoadRetryRef = useRef(0);
  const bootShortcutRetryRef = useRef(0);
  const wantSeriesRef = useRef<boolean>(false);
  const wantFlowRef = useRef<boolean>(false);
  const loadBooksRef = useRef<
    (ids: string[], opts?: { updateSeries?: boolean; updateFlow?: boolean }) => Promise<void>
  >(async () => {});

  const [globalTradeLane, setGlobalTradeLane] = useState<'up' | 'down'>('up');
  /** Operator picked UP/DOWN on the trade panel — block card lane sync until Take signal or lock expires. */
  const operatorTradeLaneLockRef = useRef<{ lane: 'up' | 'down'; at: number } | null>(null);
  const OPERATOR_TRADE_LANE_LOCK_MS = 120_000;
  const [tradePanelOpen, setTradePanelOpen] = useState(false);
  const [tradeUiPrefs, setTradeUiPrefs] = useState(() => loadTradeUiPreferences());
  const setTradeUiPref = useCallback((patch: Partial<typeof tradeUiPrefs>) => {
    setTradeUiPrefs((prev) => {
      const next = { ...prev, ...patch };
      saveTradeUiPreferences(next);
      return next;
    });
  }, []);
  const [positionsPanelOpen, setPositionsPanelOpen] = useState(false);
  const [globalTradeLocked, setGlobalTradeLocked] = useState(false);
  const [updownPickerOpen, setUpdownPickerOpen] = useState(false);
  /** Titled Polymarket hourly/daily slugs: map slug → bucket start so RTDS + PTB align like `btc-updown-1h-*`. */
  const [updownSlugHints, setUpdownSlugHints] = useState<Record<string, UpdownSlugHint>>({});
  const updownParsed = useMemo(
    () => parseUpdownSlugWithHints(selectedSlug, updownSlugHints),
    [selectedSlug, updownSlugHints],
  );
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

  useEffect(() => {
    selectedSlugRef.current = selectedSlug;
  }, [selectedSlug]);

  useEffect(() => {
    const onLaneSync = (ev: Event) => {
      const d = (ev as CustomEvent<BpxSignalsLaneSyncDetail>).detail;
      if (d?.lane !== 'up' && d?.lane !== 'down') return;
      const slug = String(d.slug ?? '').trim();
      if (!slug) return;
      const chartSlug = selectedSlugRef.current.trim();
      const tradeSlug = (globalTradeLocked && globalTradeContext?.slug
        ? globalTradeContext.slug
        : chartSlug
      ).trim();
      if (!tradeSlug || slug !== tradeSlug) return;
      const force = d.force === true;
      const lock = operatorTradeLaneLockRef.current;
      if (
        !force &&
        lock != null &&
        Date.now() - lock.at < OPERATOR_TRADE_LANE_LOCK_MS &&
        lock.lane !== d.lane
      ) {
        return;
      }
      if (force) operatorTradeLaneLockRef.current = null;
      setGlobalTradeLane(d.lane);
    };
    window.addEventListener(BPX_SIGNALS_LANE_SYNC_EVENT, onLaneSync as EventListener);
    return () => window.removeEventListener(BPX_SIGNALS_LANE_SYNC_EVENT, onLaneSync as EventListener);
  }, [globalTradeLocked, globalTradeContext?.slug]);

  useEffect(() => {
    if (!selectedSlug.trim() || !marketJson || typeof marketJson !== 'object') return;
    if (parseUpdownSlug(selectedSlug)) return;
    const hint = inferUpdownHintFromMarketJson(selectedSlug, marketJson as Record<string, unknown>);
    if (!hint) return;
    const k = selectedSlug.trim().toLowerCase();
    setUpdownSlugHints((m) => {
      const prev = m[k];
      if (prev && prev.bucketStartSec === hint.bucketStartSec && prev.interval === hint.interval) return m;
      return { ...m, [k]: hint };
    });
  }, [selectedSlug, marketJson]);

  useEffect(() => {
    applyPaperSettlementForLoadedMarket({
      market: marketJson,
      slug: selectedSlug,
      marketTitle: pickMarketQuestion(marketJson),
    });
  }, [marketJson, selectedSlug]);

  useEffect(() => {
    wantSeriesRef.current = mainTab === 'book' || mainTab === 'flowzones' || mainTab === 'signals';
    wantFlowRef.current = mainTab === 'book' || mainTab === 'flowzones' || mainTab === 'signals';
  }, [mainTab]);

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

  /** Unpin trade panel when the chart loads a different market so Signals / positions stay aligned. */
  useEffect(() => {
    const chart = selectedSlug.trim();
    const pinned = globalTradeContext?.slug?.trim() ?? '';
    if (globalTradeLocked && chart && pinned && chart !== pinned) {
      setGlobalTradeLocked(false);
    }
  }, [selectedSlug, globalTradeContext?.slug, globalTradeLocked]);

  const effectiveTradeContext = globalTradeLocked && globalTradeContext ? globalTradeContext : currentTradeContext;
  const effectiveTradeReady = Boolean(effectiveTradeContext.slug) && globalTradeReady && !binanceSpotActive;
  const effectiveTradeEnabled = Boolean(effectiveTradeContext.upToken && effectiveTradeContext.downToken);
  const trackingConditionId = useMemo(() => pickConditionId(marketJson), [marketJson]);

  const signalsProbMids = useMemo(() => {
    const slug = selectedSlug.trim();
    if (!slug || !books || books.length < 2 || outcomeLabels.length < 2) {
      return { up: [] as SpotPoint[], down: [] as SpotPoint[] };
    }
    const idx = resolveUpDownIndices(outcomeLabels, marketJson);
    if (!idx) return { up: [] as SpotPoint[], down: [] as SpotPoint[] };
    const upE = books[idx.up];
    const downE = books[idx.down];
    const tokU = upE?.token;
    const tokD = downE?.token;
    const m = chartSeriesBySlug[slug] ?? {};
    const anchorMs = booksFetchedAt ?? Date.now();
    const upLive = upE && !upE.error ? midPrice(upE.book) : null;
    const downLive = downE && !downE.error ? midPrice(downE.book) : null;
    const stepSec = updownParsed?.stepSec ?? 300;
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
      up: tokU ? appendLiveMidSeries(clean(m[tokU] ?? []), upLive, anchorMs) : [],
      down: tokD ? appendLiveMidSeries(clean(m[tokD] ?? []), downLive, anchorMs) : [],
    };
  }, [books, booksFetchedAt, chartSeriesBySlug, marketJson, outcomeLabels, selectedSlug, updownParsed]);

  /** Implied-mid charts: book poll + latest series point (not poll time alone). */
  const signalsProbFeedLastMs = useMemo(() => {
    const up = signalsProbMids.up;
    const down = signalsProbMids.down;
    return maxFeedMs(booksFetchedAt, lastPointMs(up), lastPointMs(down));
  }, [booksFetchedAt, signalsProbMids.down, signalsProbMids.up]);

  /** Spot feed freshness — RTDS tick, server receive, and last successful poll. */
  const signalsSpotFeedLastMs = useMemo(() => {
    const slug = selectedSlug.trim();
    const spotPts = slug ? (spotSeriesBySlug[slug] ?? []) : [];
    return maxFeedMs(rtdsTickAt, rtdsReceivedAt, rtdsLastPollMs, lastPointMs(spotPts));
  }, [rtdsTickAt, rtdsReceivedAt, rtdsLastPollMs, selectedSlug, spotSeriesBySlug]);

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

  const loadMarket = useCallback(async (slug: string, opts?: { market?: unknown }): Promise<LoadMarketResult> => {
    releaseOrphanPointerCapture();
    const syncGen = ++marketSyncGenRef.current;
    setBinanceSpotActive(false);
    const clean = normalizeMarketLookupRef(slug);
    setSelectedSlug(clean);
    selectedSlugRef.current = clean;
    setSlugInput(clean || slug.trim());
    setError(null);
    setMarketJson(null);
    setBooks(null);
    setBooksFetchedAt(null);
    setBooksLoading(Boolean(clean));
    setGlobalTradeLocked(false);
    setSsrPriceToBeat(null);
    setSsrPtbSource(null);
    setPtbError(null);
    setRtdsSpot(null);
    setRtdsTickAt(null);
    setRtdsReceivedAt(null);
    setRtdsLastPollMs(null);
    if (clean) {
      setChartSeriesBySlug((m) => {
        const next = { ...m };
        delete next[clean];
        return next;
      });
      setFlowSeriesBySlug((m) => {
        const next = { ...m };
        delete next[clean];
        return next;
      });
      setSpotSeriesBySlug((m) => {
        const next = { ...m };
        delete next[clean];
        return next;
      });
      try {
        const u = new URL(window.location.href);
        u.searchParams.set('slug', clean);
        window.history.replaceState(null, '', u.pathname + u.search + u.hash);
      } catch {
        /* ignore */
      }
    }
    if (!clean) {
      setBooksLoading(false);
      return { ok: false };
    }
    const preloaded = opts?.market;
    if (preloaded != null && typeof preloaded === 'object') {
      if (syncGen !== marketSyncGenRef.current) return { ok: false };
      setMarketJson(preloaded);
      const ids = pickTokenIds(preloaded);
      if (ids.length >= 2) {
        queueMicrotask(() => {
          void loadBooksRef.current(ids, {
            updateSeries: wantSeriesRef.current,
            updateFlow: wantFlowRef.current,
          });
        });
      } else {
        setBooksLoading(false);
      }
      return { ok: true, slug: clean, data: preloaded };
    }
    const res = await marketsGet(clean);
    if (syncGen !== marketSyncGenRef.current) return { ok: false };
    if (isOk(res)) {
      setMarketJson(res.data);
      const ids = pickTokenIds(res.data);
      if (ids.length >= 2) {
        queueMicrotask(() => {
          void loadBooksRef.current(ids, {
            updateSeries: wantSeriesRef.current,
            updateFlow: wantFlowRef.current,
          });
        });
      }
      return { ok: true, slug: clean, data: res.data };
    }
    setError(pretty(res));
    setBooksLoading(false);
    return { ok: false };
  }, []);

  const onGlobalTradeLaneChange = useCallback(
    (lane: 'up' | 'down') => {
      setGlobalTradeLane(lane);
      operatorTradeLaneLockRef.current = { lane, at: Date.now() };
      if (!activeTradeSessionTabId) return;
      setTradeSessionTabs((list) => list.map((t) => (t.id === activeTradeSessionTabId ? { ...t, lane } : t)));
    },
    [activeTradeSessionTabId],
  );

  const tradePanelSharedProps = useMemo(
    () => ({
      marketSlug: effectiveTradeContext.slug,
      marketQuestion: effectiveTradeContext.question,
      gammaMarket: marketJson,
      probMomentumUp: signalsProbMids.up,
      probMomentumDown: signalsProbMids.down,
      upLabel: effectiveTradeContext.upLabel,
      downLabel: effectiveTradeContext.downLabel,
      upToken: effectiveTradeContext.upToken,
      downToken: effectiveTradeContext.downToken,
      upMid:
        (signalsProbMids.up.length ? signalsProbMids.up[signalsProbMids.up.length - 1]!.v : null) ??
        tradePanelBookMids.up,
      downMid:
        (signalsProbMids.down.length ? signalsProbMids.down[signalsProbMids.down.length - 1]!.v : null) ??
        tradePanelBookMids.down,
      bookMidUp: tradePanelBookMids.up,
      bookMidDown: tradePanelBookMids.down,
      bookTouchUp: tradePanelBookTouch.up,
      bookTouchDown: tradePanelBookTouch.down,
      lane: globalTradeLane,
      onLaneChange: onGlobalTradeLaneChange,
    }),
    [
      effectiveTradeContext,
      marketJson,
      signalsProbMids.down,
      signalsProbMids.up,
      tradePanelBookMids.down,
      tradePanelBookMids.up,
      tradePanelBookTouch.down,
      tradePanelBookTouch.up,
      globalTradeLane,
      onGlobalTradeLaneChange,
    ],
  );

  const showEmbeddedTradeDock =
    tradeUiPrefs.embedded &&
    !binanceSpotActive &&
    (mainTab === 'signals' || mainTab === 'book' || mainTab === 'tracking' || mainTab === 'flowzones');

  /** Slide trade panel is fixed on the right — shrink main column so charts are not covered. */
  const tradeSlideReservesSpace = tradeUiPrefs.slide && tradePanelOpen;

  const openTradeUi = useCallback(() => {
    if (tradeUiPrefs.slide) {
      setTradePanelOpen(true);
      return;
    }
    if (!tradeUiPrefs.embedded) {
      setTradeUiPref({ embedded: true, slide: true });
    }
    if (mainTab !== 'signals' && mainTab !== 'book' && mainTab !== 'tracking') {
      setMainTab('signals');
    }
  }, [mainTab, setTradeUiPref, tradeUiPrefs.embedded, tradeUiPrefs.slide]);

  useEffect(() => {
    const onOpenTrade = (ev: Event) => {
      const d = (ev as CustomEvent<{ lane?: 'up' | 'down' }>).detail;
      if (d?.lane === 'up' || d?.lane === 'down') setGlobalTradeLane(d.lane);
      openTradeUi();
    };
    window.addEventListener(BPX_TRADE_PANEL_OPEN_EVENT, onOpenTrade as EventListener);
    return () => window.removeEventListener(BPX_TRADE_PANEL_OPEN_EVENT, onOpenTrade as EventListener);
  }, [openTradeUi]);

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

  const seedBookFromPriceChange = (c: ClobWsPriceChange): { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] } | null => {
    const bidPx = c.best_bid != null && c.best_bid !== '' && c.best_bid !== '0' ? String(c.best_bid) : null;
    const askPx = c.best_ask != null && c.best_ask !== '' && c.best_ask !== '0' ? String(c.best_ask) : null;
    if (!bidPx && !askPx) return null;
    return {
      bids: bidPx ? [{ price: bidPx, size: '1' }] : [],
      asks: askPx ? [{ price: askPx, size: '1' }] : [],
    };
  };

  const loadBooks = useCallback(async (ids: string[], opts?: { updateSeries?: boolean; updateFlow?: boolean }) => {
    if (ids.length === 0) {
      setBooks(null);
      setBooksLoading(false);
      return;
    }
    const syncGen = marketSyncGenRef.current;
    const reqKey = `${selectedSlugRef.current}:${ids.join(',')}`;
    setBooksLoading(true);
    setError(null);
    try {
      const res = await clobBooks(ids);
      if (syncGen !== marketSyncGenRef.current) return;
      if (`${selectedSlugRef.current}:${ids.join(',')}` !== reqKey) return;
      if (isOk(res)) {
        setBooks(res.data);
        const ts = Date.now();
        setBooksFetchedAt(ts);
        const updateSeries = opts?.updateSeries === true;
        const updateFlow = opts?.updateFlow === true;
        if (updateSeries) {
          const slug = selectedSlugRef.current.trim();
          setChartSeriesBySlug((m) => {
            if (!slug) return m;
            const existingForSlug = m[slug] ?? {};
            const nextForSlug: Record<string, SeriesPoint[]> = { ...existingForSlug };
            for (const e of res.data) {
              const token = e.token;
              const v = e.error ? null : midPrice(e.book);
              const prev = nextForSlug[token] ?? [];
              nextForSlug[token] = [...prev, { t: ts, v }].slice(-180);
            }
            return { ...m, [slug]: nextForSlug };
          });
        }
        if (updateFlow) {
          const slug = selectedSlugRef.current.trim();
          setFlowSeriesBySlug((m) => {
            if (!slug) return m;
            const existingForSlug = m[slug] ?? {};
            const nextForSlug: Record<string, BookSnapshot[]> = { ...existingForSlug };
            for (const e of res.data) {
              const token = e.token;
              const key = `${slug}:${token}`;
              const prevMaps = prevDepthMapsRef.current[key] ?? null;
              const prev = nextForSlug[token] ?? [];
              if (e.error) continue;
              const { snap, next } = snapshotFromBook(e.book, ts, prevMaps);
              prevDepthMapsRef.current[key] = next;
              nextForSlug[token] = [...prev, snap].slice(-360);
            }
            return { ...m, [slug]: nextForSlug };
          });
        }
      } else setError(pretty(res));
    } finally {
      if (syncGen === marketSyncGenRef.current && `${selectedSlugRef.current}:${ids.join(',')}` === reqKey) {
        setBooksLoading(false);
      }
    }
  }, []);

  loadBooksRef.current = loadBooks;

  // Prefer WS market channel (instant); polling remains as a fallback.
  const booksWsRef = useRef<ReturnType<typeof openClobMarketChannel> | null>(null);
  const booksCacheRef = useRef<Map<string, { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] }>>(new Map());
  const booksWsIdsRef = useRef<string>('');
  const booksRafRef = useRef<number | null>(null);
  const booksDirtyRef = useRef(false);
  const [booksWsStatus, setBooksWsStatus] = useState<string | null>(null);
  const [booksWsEpoch, setBooksWsEpoch] = useState(0);
  const booksWsReconnectRef = useRef<number | null>(null);

  useEffect(() => {
    if (binanceSpotActive) {
      booksWsRef.current?.close();
      booksWsRef.current = null;
      booksCacheRef.current = new Map();
      booksWsIdsRef.current = '';
      setBooksWsStatus(null);
      setBooksLoading(false);
      return;
    }
    const ids = tokenIds;
    const key = ids.join(',');
    const idsSet = new Set(ids);
    if (!ids || ids.length === 0) {
      booksWsRef.current?.close();
      booksWsRef.current = null;
      booksCacheRef.current = new Map();
      booksWsIdsRef.current = '';
      setBooksLoading(false);
      return;
    }
    if (booksWsRef.current && booksWsIdsRef.current === key) {
      if (ids.some((id) => booksCacheRef.current.has(id))) setBooksLoading(false);
      return;
    }

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
      if (booksWsIdsRef.current !== key) return;
      booksDirtyRef.current = false;
      const ts = Date.now();
      const entries = toEntries();
      setBooks(entries);
      setBooksFetchedAt(ts);
      setBooksLoading(false);

      const slug = selectedSlugRef.current.trim();
      if (!slug) return;

      if (wantSeriesRef.current) {
        setChartSeriesBySlug((m) => {
          const existingForSlug = m[slug] ?? {};
          const nextForSlug: Record<string, SeriesPoint[]> = { ...existingForSlug };
          for (const e of entries) {
            const token = e.token;
            const v = e.error ? null : midPrice(e.book);
            const prev = nextForSlug[token] ?? [];
            nextForSlug[token] = [...prev, { t: ts, v }].slice(-180);
          }
          return { ...m, [slug]: nextForSlug };
        });
      }

      if (wantFlowRef.current) {
        setFlowSeriesBySlug((m) => {
          const existingForSlug = m[slug] ?? {};
          const nextForSlug: Record<string, BookSnapshot[]> = { ...existingForSlug };
          for (const e of entries) {
            const token = e.token;
            const key = `${slug}:${token}`;
            const prevMaps = prevDepthMapsRef.current[key] ?? null;
            const prev = nextForSlug[token] ?? [];
            if (e.error) continue;
            const { snap, next } = snapshotFromBook(e.book, ts, prevMaps);
            prevDepthMapsRef.current[key] = next;
            nextForSlug[token] = [...prev, snap].slice(-360);
          }
          return { ...m, [slug]: nextForSlug };
        });
      }
    };

    // Coalesce book updates to avoid rendering at full WS tick rate.
    // Rendering ~60fps from websocket churn can cause visible UI jank.
    const MIN_FLUSH_MS = 150;
    let lastFlushAt = 0;
    let flushTimer: number | null = null;

    const scheduleFlush = () => {
      booksDirtyRef.current = true;
      if (booksRafRef.current != null || flushTimer != null) return;
      const now = Date.now();
      const waitMs = Math.max(0, MIN_FLUSH_MS - (now - lastFlushAt));
      if (waitMs === 0) {
        lastFlushAt = now;
        booksRafRef.current = window.requestAnimationFrame(flushBooks);
        return;
      }
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        lastFlushAt = Date.now();
        if (booksRafRef.current == null) booksRafRef.current = window.requestAnimationFrame(flushBooks);
      }, waitMs);
    };

    const bootstrapBooks = () => {
      void loadBooks(ids, { updateSeries: wantSeriesRef.current, updateFlow: wantFlowRef.current });
    };

    booksWsRef.current = openClobMarketChannel({
      assetIds: ids,
      onBook: (assetId, book) => {
        booksCacheRef.current.set(assetId, book);
        scheduleFlush();
      },
      onBestBidAsk: (assetId, best) => {
        const merged = mergeWsBestBidAsk(booksCacheRef.current.get(assetId), best);
        booksCacheRef.current.set(assetId, merged);
        scheduleFlush();
      },
      onStatus: (s) => {
        setBooksWsStatus(s.state === 'open' ? 'open' : s.state === 'closed' ? 'closed' : `error:${s.detail ?? ''}`);
        if (s.state === 'open') {
          if (booksWsReconnectRef.current != null) {
            window.clearTimeout(booksWsReconnectRef.current);
            booksWsReconnectRef.current = null;
          }
          bootstrapBooks();
          return;
        }
        if (s.state === 'error') bootstrapBooks();
        if (s.state === 'closed' || s.state === 'error') {
          if (booksWsReconnectRef.current != null) return;
          booksWsReconnectRef.current = window.setTimeout(() => {
            booksWsReconnectRef.current = null;
            booksWsRef.current?.close();
            booksWsRef.current = null;
            booksWsIdsRef.current = '';
            setBooksWsEpoch((n) => n + 1);
          }, 2_500);
        }
      },
      onPriceChanges: (changes) => {
        let touched = false;
        for (const c of changes) {
          const id = c.asset_id;
          if (!idsSet.has(id)) continue;
          let book = booksCacheRef.current.get(id);
          if (!book) {
            const seeded = seedBookFromPriceChange(c);
            if (!seeded) continue;
            book = seeded;
            booksCacheRef.current.set(id, book);
            touched = true;
            continue;
          }
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

    bootstrapBooks();

    return () => {
      if (booksWsReconnectRef.current != null) {
        window.clearTimeout(booksWsReconnectRef.current);
        booksWsReconnectRef.current = null;
      }
      if (booksRafRef.current != null) window.cancelAnimationFrame(booksRafRef.current);
      booksRafRef.current = null;
      if (flushTimer != null) window.clearTimeout(flushTimer);
      flushTimer = null;
      booksDirtyRef.current = false;
      booksWsRef.current?.close();
      booksWsRef.current = null;
      booksCacheRef.current = new Map();
      booksWsIdsRef.current = '';
      setBooksLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenIds.join(','), binanceSpotActive, booksWsEpoch]);

  useEffect(() => {
    if (!booksLoading) return;
    const id = window.setTimeout(() => setBooksLoading(false), 12_000);
    return () => window.clearTimeout(id);
  }, [booksLoading, selectedSlug, tokenIds.join(',')]);

  useEffect(() => {
    if (!shortcutBusy) return;
    const id = window.setTimeout(() => setShortcutBusy(null), 45_000);
    return () => window.clearTimeout(id);
  }, [shortcutBusy]);

  // REST book poll: idle markets may get no WS deltas, so `booksFetchedAt` would age out while the book is still valid.
  useEffect(() => {
    if (binanceSpotActive) return;
    const pollTabs = new Set(['book', 'flowzones', 'signals', 'tracking']);
    if (!pollTabs.has(mainTab)) return;
    if (mainTab === 'book' && !chartEnabled) return;
    if (!tokenIds || tokenIds.length === 0) return;
    if (!selectedSlug) return;

    let stopped = false;
    const run = () => {
      if (stopped) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const wantSeries = mainTab === 'book' || mainTab === 'flowzones' || mainTab === 'signals';
      const wantFlow = mainTab === 'book' || mainTab === 'flowzones' || mainTab === 'signals';
      void loadBooks(tokenIds, { updateSeries: wantSeries, updateFlow: wantFlow });
    };

    const intervalMs = mainTab === 'book' ? 5_000 : mainTab === 'signals' ? 4_000 : 6_500;
    void run();
    const id = window.setInterval(() => void run(), intervalMs);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [chartEnabled, loadBooks, mainTab, selectedSlug, tokenIds, binanceSpotActive]);

  /** If CLOB WS goes quiet, REST + reconnect so implied mids do not sit "stale" for minutes. */
  useEffect(() => {
    if (binanceSpotActive || mainTab !== 'signals') return;
    if (!selectedSlug.trim() || tokenIds.length === 0) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const age = booksFetchedAt == null ? Number.POSITIVE_INFINITY : Date.now() - booksFetchedAt;
      if (age < 35_000) return;
      void loadBooks(tokenIds, { updateSeries: true, updateFlow: true });
      if (age > 50_000) setBooksWsEpoch((n) => n + 1);
    }, 12_000);
    return () => window.clearInterval(id);
  }, [binanceSpotActive, booksFetchedAt, loadBooks, mainTab, selectedSlug, tokenIds]);

  useEffect(() => {
    if (binanceSpotActive) return;
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      if (!tokenIds || tokenIds.length === 0) return;
      const wantSeries = mainTab === 'book' || mainTab === 'flowzones' || mainTab === 'signals';
      const wantFlow = mainTab === 'book' || mainTab === 'flowzones' || mainTab === 'signals';
      void loadBooks(tokenIds, { updateSeries: wantSeries, updateFlow: wantFlow });
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [tokenIds, mainTab, loadBooks, binanceSpotActive]);

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

      // Defer the market list so first paint happens quickly.
      const defer = (cb: () => void) => {
        try {
          const ric = (window as unknown as { requestIdleCallback?: (fn: () => void, opts?: { timeout?: number }) => number })
            .requestIdleCallback;
          if (typeof ric === 'function') {
            ric(cb, { timeout: 1200 });
            return;
          }
        } catch {
          /* ignore */
        }
        window.setTimeout(cb, 250);
      };
      defer(() => {
        void (async () => {
          setMarketsListLoading(true);
          const list = await marketsList(25);
          setMarketsListLoading(false);
          if (isOk(list)) {
            setMarkets(asMarketRows(list.data));
            if (asMarketRows(list.data).length === 0) {
              setMarketsError('Markets list returned zero rows. Start the API (`npm run dev`) and hard-refresh, or open a market by slug below.');
            } else {
              setMarketsError(null);
            }
          } else {
            setMarkets([]);
            setMarketsError(pretty(list) + apiReachabilityHint(list));
          }
        })();
      });
    })();
  }, []);

  useEffect(() => {
    if (binanceSpotActive) return;
    if (tokenIds.length === 0) {
      queueMicrotask(() => setBooks(null));
      return;
    }
    const wantSeries = mainTab === 'book' || mainTab === 'flowzones' || mainTab === 'signals';
    const wantFlow = mainTab === 'book' || mainTab === 'flowzones' || mainTab === 'signals';
    queueMicrotask(() => void loadBooks(tokenIds, { updateSeries: wantSeries, updateFlow: wantFlow }));
  }, [tokenIds, loadBooks, mainTab, binanceSpotActive]);

  /** Signals tab: immediately hydrate implied-prob + flow rings (do not wait for the 6.5s poll). */
  useEffect(() => {
    if (binanceSpotActive) return;
    if (mainTab !== 'signals') return;
    if (!selectedSlug.trim() || tokenIds.length === 0) return;
    void loadBooks(tokenIds, { updateSeries: true, updateFlow: true });
  }, [binanceSpotActive, loadBooks, mainTab, selectedSlug, tokenIds]);

  useEffect(() => {
    if (!books || books.length === 0) {
      queueMicrotask(() => setOutcomeTab(0));
      return;
    }
    const n = books.length;
    queueMicrotask(() => setOutcomeTab((t) => Math.min(Math.max(0, t), n - 1)));
  }, [books]);

  /** First visit: load `?slug=` from URL, else auto-open BTC 5m so Signals is not an empty shell. */
  useEffect(() => {
    if (marketBootRef.current) return;
    marketBootRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const slug = (params.get('slug') ?? params.get('market') ?? '').trim();
    if (slug) {
      void loadMarket(slug);
      return;
    }
    let cancelled = false;
    (async () => {
      setShortcutBusy({ asset: 'btc', interval: '5m' });
      try {
        const res = await marketsUpdownShortcut('btc', '5m');
        if (cancelled) return;
        if (!isOk(res)) {
          setMarketsError(pretty(res));
          marketBootRef.current = false;
          return;
        }
        const slugToOpen = res.data.trading_slug?.trim() || res.data.slug.trim();
        void loadMarket(slugToOpen, { market: res.data.market });
      } catch (e) {
        if (!cancelled) {
          setMarketsError(e instanceof Error ? e.message : String(e));
          marketBootRef.current = false;
        }
      } finally {
        if (!cancelled) setShortcutBusy(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMarket]);

  useEffect(() => {
    marketLoadRetryRef.current = 0;
  }, [selectedSlug]);

  /** Shortcut picked a slug but Gamma metadata failed — retry a few times before giving up. */
  useEffect(() => {
    const slug = selectedSlug.trim();
    if (!slug || marketJson) return;
    if (!error || (!error.includes('market_get_failed') && !error.includes('fetch_failed'))) return;
    if (marketLoadRetryRef.current >= 4) return;
    const delayMs = 800 + marketLoadRetryRef.current * 900;
    const id = window.setTimeout(() => {
      marketLoadRetryRef.current += 1;
      void loadMarket(slug);
    }, delayMs);
    return () => window.clearTimeout(id);
  }, [selectedSlug, marketJson, error, loadMarket]);

  /** First boot failed while API was still warming — retry BTC 5m once health is OK. */
  useEffect(() => {
    if (selectedSlug.trim() || shortcutBusy) return;
    if (!apiHealth.startsWith('API OK')) return;
    if (marketBootRef.current) return;
    if (bootShortcutRetryRef.current >= 2) return;
    bootShortcutRetryRef.current += 1;
    void openUpdownShortcut('btc', '5m');
  }, [apiHealth, selectedSlug, shortcutBusy]);

  /** PTB poll — depends on slug only. Do not list `ssrPriceToBeat` in deps: clearing PTB when it
   *  updates caused the Signals chart to flicker between live data and the SSR skeleton. */
  useEffect(() => {
    const slug = selectedSlug.trim();
    if (!slug) {
      queueMicrotask(() => {
        setSsrPriceToBeat(null);
        setSsrPtbSource(null);
      });
      return;
    }
    const ptbGen = marketSyncGenRef.current;
    queueMicrotask(() => {
      setSsrPriceToBeat(null);
      setSsrPtbSource(null);
      setPtbError(null);
    });
    let stopped = false;
    let intervalId: ReturnType<typeof window.setInterval> | null = null;
    let slowPoll = false;
    const tick = async () => {
      const ptb = await priceToBeat(slug);
      if (stopped) return;
      if (ptbGen !== marketSyncGenRef.current) return;
      if (selectedSlugRef.current.trim() !== slug) return;
      if (isOk(ptb)) {
        setSsrPriceToBeat(ptb.data.price_to_beat);
        setSsrPtbSource(ptb.data.source);
        setPtbError(null);
        if (!slowPoll && intervalId != null && !ptb.data.preview) {
          slowPoll = true;
          window.clearInterval(intervalId);
          intervalId = window.setInterval(() => void tick(), 20_000);
        }
      } else {
        // Keep last good PTB only when still the same market load generation.
        setPtbError(pretty(ptb));
      }
    };
    void tick();
    intervalId = window.setInterval(() => void tick(), 5_000);
    return () => {
      stopped = true;
      if (intervalId != null) window.clearInterval(intervalId);
    };
  }, [selectedSlug]);

  useEffect(() => {
    setRtdsSpotFeedSource(null);
    setSpotBySymbol((m) => {
      const sym = (() => {
        const p = parseUpdownSlugWithHints(selectedSlug, updownSlugHints);
        if (p) return `${p.asset}/usd`;
        const titled = titledUpdownAssetFromSlug(selectedSlug);
        if (titled) return `${titled}/usd`;
        return null;
      })();
      if (!sym?.endsWith('/usd')) return m;
      return { ...m, [sym]: [] };
    });
  }, [selectedSlug, updownSlugHints]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    writeStringArray(PTB_WATCH_SLUGS_KEY, ptbWatchSlugs);
  }, [ptbWatchSlugs]);

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
  const rtdsPollFast = isUpdownDeskMarket(selectedSlug, updownSlugHints) && spotLenForRtds < 2;

  useEffect(() => {
    const symFromSlug = (slug: string): string | null => {
      const p = parseUpdownSlugWithHints(slug, updownSlugHints);
      if (p) return `${p.asset}/usd`;
      const hint = inferUpdownHintFromMarketJson(
        slug,
        marketJson && typeof marketJson === 'object' ? (marketJson as Record<string, unknown>) : {},
      );
      if (hint) return `${hint.asset}/usd`;
      const titled = titledUpdownAssetFromSlug(slug);
      if (titled) return `${titled}/usd`;
      return null;
    };
    const collect = (): string[] => {
      const s = new Set<string>(['btc/usd', 'btc/usdt', 'eth/usd', 'sol/usd']);
      const a = symFromSlug(selectedSlug);
      if (a) s.add(a);
      // Only fan out to scan-list symbols when Multi scan is visible (avoids hammering RTDS).
      if (mainTab === 'multiscan') {
        for (const w of ptbWatchSlugs) {
          const sym = symFromSlug(w);
          if (sym) s.add(sym);
        }
      }
      return Array.from(s).slice(0, 10);
    };
    const selectedSym = symFromSlug(selectedSlug);
    // Fast-boot should hydrate the active chart quickly without hammering RTDS for every watched slug.
    const SYMS = rtdsPollFast
      ? selectedSym
        ? [selectedSym]
        : ['btc/usd', 'eth/usd', 'sol/usd']
      : collect();
    let stopped = false;
    let inflight = false;
    let pendingTick = false;
    const tick = async () => {
      if (stopped) return;
      if (inflight) {
        pendingTick = true;
        return;
      }
      inflight = true;
      try {
        const results = await Promise.all(SYMS.map((s) => rtdsCrypto(s)));
        const base = spotBySymbolRef.current;
        const next: Record<string, SpotPoint[]> = { ...base };
        let okAny = false;
        let firstErr: string | null = null;
        let activeReceivedAt: number | null = null;
        for (let i = 0; i < SYMS.length; i++) {
          const sym = SYMS[i]!;
          const res = results[i]!;
          if (!isOk(res)) {
            if (firstErr == null) firstErr = pretty(res);
            continue;
          }
          okAny = true;
          next[sym] = mergeSpotHistory(base[sym] ?? [], res.data, sym);
        }
        setSpotBySymbol(next);
        setRtdsError(okAny ? null : firstErr);
        const sym = symFromSlug(selectedSlug);
        const pollAt = Date.now();
        if (sym) {
          for (let i = 0; i < SYMS.length; i++) {
            if (SYMS[i] !== sym) continue;
            const res = results[i]!;
            if (isOk(res)) {
              if (Number.isFinite(res.data.receivedAt) && res.data.receivedAt > 0) {
                activeReceivedAt = res.data.receivedAt;
              }
              queueMicrotask(() => setRtdsLastPollMs(pollAt));
            }
            break;
          }
        }
        if (!sym) {
          queueMicrotask(() => {
            setRtdsSpot(null);
            setRtdsTickAt(null);
            setRtdsReceivedAt(null);
            setRtdsSpotFeedSource(null);
            setSpotSeriesBySlug((m) => {
              if (!selectedSlug.trim()) return m;
              const rest = { ...m };
              delete (rest as Record<string, unknown>)[selectedSlug];
              return rest;
            });
          });
          return;
        }
        const series = next[sym] ?? [];
        let spotSrc: string | null = null;
        for (let i = 0; i < SYMS.length; i++) {
          if (SYMS[i] !== sym) continue;
          const res = results[i]!;
          if (isOk(res)) spotSrc = res.data.source;
          break;
        }
        queueMicrotask(() => {
          setSpotSeriesBySlug((m) => ({ ...m, [selectedSlug]: series }));
          if (spotSrc != null) setRtdsSpotFeedSource(spotSrc);
          if (activeReceivedAt != null) setRtdsReceivedAt(activeReceivedAt);
          const liveRes = SYMS.map((s, i) => ({ s, r: results[i]! })).find((x) => x.s === sym)?.r;
          if (liveRes && isOk(liveRes) && (liveRes.data.source === 'chainlink' || !sym.endsWith('/usd'))) {
            setRtdsSpot(liveRes.data.value);
            setRtdsTickAt(normalizeEpochMs(liveRes.data.ts) ?? liveRes.data.ts);
          } else if (series.length > 0) {
            const last = series[series.length - 1]!;
            setRtdsSpot(last.v);
            setRtdsTickAt(normalizeEpochMs(last.t) ?? last.t);
          }
        });
      } finally {
        inflight = false;
        if (pendingTick && !stopped) {
          pendingTick = false;
          void tick();
        }
      }
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
    // RTDS numbers feel "frozen" if we poll too slowly. Keep 1s cadence for normal mode.
    const intervalMs = rtdsPollFast ? 750 : 1_000;
    const id = window.setInterval(() => void tick(), intervalMs);
    const onVis = () => {
      if (document.visibilityState !== 'visible' || stopped) return;
      void tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopped = true;
      window.clearInterval(id);
      for (const t of bootTimers) window.clearTimeout(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [selectedSlug, ptbWatchSlugs, rtdsPollFast, mainTab, updownParsed, updownSlugHints, marketJson]);

  useEffect(() => {
    if (mainTab !== 'multiscan') return;
    const slugs = [...new Set(ptbWatchSlugs.filter((s) => parseUpdownSlugWithHints(s, updownSlugHints) != null))];
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
  }, [ptbWatchSlugs, mainTab, updownSlugHints]);

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
        const p = parseUpdownSlugWithHints(slug, updownSlugHints);
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
  }, [ptbWatchSlugs, spotBySymbol, watchMetaBySlug, selectedSlug, ssrPriceToBeat, marketEndsInMs, updownSlugHints]);

  const updownPickerItems = useMemo(() => {
    const p = updownParsed;
    if (!p) return [];
    const step = p.stepSec;
    // Snap to exact window boundary. (ts is epoch seconds.)
    const snapped = Math.floor(p.ts / step) * step;
    const items: { slug: string; label: string; ts: number }[] = [];
    // Show a useful range per interval (keeps dropdown manageable).
    const count = p.interval === '1d' ? 14 : p.interval === '4h' ? 36 : p.interval === '1h' ? 48 : p.interval === '15m' ? 12 : 24;
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
      if (isOk(res) && typeof res.data.slug === 'string' && res.data.slug) {
        const slug = res.data.slug;
        setUpdownLiveSlugFromApi(slug);
        const iw = res.data.inferred_window_start_unix;
        if (typeof iw === 'number' && !parseUpdownSlug(slug)) {
          setUpdownSlugHints((m) => ({
            ...m,
            [slug.trim().toLowerCase()]: {
              asset: shortcutAsset,
              interval: updownParsed.interval,
              bucketStartSec: iw,
            },
          }));
        }
      }
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
    const live = updownLiveSlugFromApi ? parseUpdownSlugWithHints(updownLiveSlugFromApi, updownSlugHints) : null;
    if (!live || live.asset !== p.asset || live.interval !== p.interval) return null;
    return live.ts - p.ts;
  }, [updownParsed, updownLiveSlugFromApi, updownSlugHints]);

  const assistantContext = useMemo(
    () =>
      binanceSpotActive
        ? `Workspace: Binance BTCUSDT spot order book (not Polymarket). Polymarket slug in sidebar: ${selectedSlug.trim() || '(none)'}.\n`
        : buildAssistantContext(selectedSlug, marketJson, books, outcomeLabels),
    [binanceSpotActive, selectedSlug, marketJson, books, outcomeLabels],
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
        const isUpdown = updownParsed != null;
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
  }, [autoEnabled, assistantAvailable, assistantContext, autoBusy, books, pushAutoLine, rollingCtxText, selectedSlug, updownParsed]);

  async function openUpdownShortcut(asset: UpdownShortcutAsset, interval: UpdownInterval) {
    releaseOrphanPointerCapture();
    setError(null);
    setMarketsError(null);
    setShortcutBusy({ asset, interval });
    setLastShortcut({ asset, interval });
    try {
      const first = await marketsUpdownShortcut(asset, interval);
      let okRes: ApiOk<{
        slug: string;
        trading_slug?: string;
        market?: unknown;
        asset: string;
        interval?: string;
        window: string;
        tested?: boolean;
        active?: boolean;
        closed?: boolean;
        start?: string | null;
        end?: string | null;
      }> | null = null;

      if (isOk(first)) okRes = first;
      else {
        setMarketsError(pretty(first));
        setShortcutBusy(null);
        return;
      }

      if (!okRes) {
        setShortcutBusy(null);
        return;
      }

      if (okRes.data.start && okRes.data.end) {
        setMarketsError(
          `${asset.toUpperCase()} ${interval} window: ${new Date(okRes.data.start).toLocaleTimeString()}–${new Date(okRes.data.end).toLocaleTimeString()} · slug ${okRes.data.slug}`,
        );
      } else {
        setMarketsError(null);
      }
      let slugToOpen = okRes.data.trading_slug?.trim() || okRes.data.slug.trim();
      if (interval === '5m' && !okRes.data.trading_slug?.trim() && !okRes.data.market) {
        slugToOpen = await updownSlugToOpen(okRes.data, interval);
      }
      const iw = (okRes.data as { inferred_window_start_unix?: number }).inferred_window_start_unix;
      if (typeof iw === 'number') {
        setUpdownSlugHints((m) => ({
          ...m,
          [slugToOpen.trim().toLowerCase()]: { asset, interval, bucketStartSec: iw },
        }));
      }
      setShortcutBusy(null);
      void loadMarket(slugToOpen, { market: okRes.data.market });
    } catch (e) {
      setMarketsError(e instanceof Error ? e.message : String(e));
      setShortcutBusy(null);
    }
  }

  async function runSearch() {
    setError(null);
    setMarketsError(null);
    const term = q.trim();
    if (!term) {
      setMarketsListLoading(true);
      const list = await marketsList(25);
      setMarketsListLoading(false);
      if (isOk(list)) {
        const rows = asMarketRows(list.data);
        setMarkets(rows);
        if (rows.length === 0) setMarketsError('No markets in this page of results.');
        else setMarketsError(null);
      } else {
        setMarkets([]);
        setMarketsError(pretty(list) + apiReachabilityHint(list));
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

  const tabSuspenseFallback = (
    <div className="mt-5 rounded-2xl border border-zinc-800/50 bg-zinc-950/40 px-4 py-6 text-center text-sm text-zinc-400">
      Loading tab…
    </div>
  );

  const marketControls = (
    <>
      <div className="mb-4 flex flex-col gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Open market</div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-200/70">Polymarket · prediction</div>
        <div className="flex flex-wrap gap-2">
          {(['btc', 'eth', 'sol', 'hype'] as const).map((asset) => {
            const busy = shortcutBusy?.asset === asset && shortcutBusy.interval === '5m';
            return (
              <button
                key={`5m-${asset}`}
                type="button"
                disabled={busy}
                onClick={() => void openUpdownShortcut(asset, '5m')}
                className={`min-w-[4.5rem] flex-1 rounded-xl border px-3 py-2.5 text-center text-sm font-semibold uppercase tracking-wide transition-colors disabled:cursor-wait disabled:opacity-50 sm:flex-none ${
                  asset === 'btc'
                    ? 'border-amber-700/50 bg-amber-950/30 text-amber-100 hover:bg-amber-950/50'
                    : asset === 'eth'
                      ? 'border-indigo-700/50 bg-indigo-950/30 text-indigo-100 hover:bg-indigo-950/50'
                      : asset === 'sol'
                        ? 'border-violet-700/50 bg-violet-950/30 text-violet-100 hover:bg-violet-950/50'
                        : 'border-emerald-700/45 bg-emerald-950/20 text-emerald-100 hover:bg-emerald-950/35'
                }`}
              >
                {busy ? '…' : asset}
              </button>
            );
          })}
        </div>
        <p className="text-[10px] leading-snug text-zinc-600">
          5m Up/Down — the <span className="font-medium text-zinc-400">btc</span> chip is only the Polymarket BTC 5-minute window (share prices), not Binance spot.
        </p>
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-cyan-200/75">Separate market · spot</div>
        <div className="mt-1 rounded-xl border border-cyan-800/45 bg-cyan-950/20 p-3 ring-1 ring-cyan-500/10">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-cyan-200/85">BTC / USDT (Binance)</div>
          <p className="mt-1 text-[10px] leading-snug text-zinc-500">
            Full <span className="font-medium text-zinc-400">Book</span>, <span className="font-medium text-zinc-400">Flow</span>, and{' '}
            <span className="font-medium text-zinc-400">Signals</span> tabs use this feed (same layout as Polymarket). Not a Polymarket slug.
          </p>
          <button
            type="button"
            onClick={() => {
              setBinanceSpotActive(true);
              setMainTab('book');
            }}
            className="mt-2 w-full rounded-xl border border-cyan-600/45 bg-cyan-950/35 px-3 py-2.5 text-center text-sm font-semibold tracking-tight text-cyan-50 shadow-sm transition-colors hover:border-cyan-500/55 hover:bg-cyan-950/50"
          >
            Open BTC / USDT market
          </button>
        </div>
        {(['15m', '1h', '4h', '1d'] as const).map((interval) => (
          <div key={interval} className="mt-2">
            <div className="flex flex-wrap gap-2">
              {(['btc', 'eth', 'sol', 'hype'] as const).map((asset) => {
                const busy = shortcutBusy?.asset === asset && shortcutBusy.interval === interval;
                return (
                  <button
                    key={`${interval}-${asset}`}
                    type="button"
                    disabled={busy}
                    onClick={() => void openUpdownShortcut(asset, interval)}
                    className={`min-w-[4.5rem] flex-1 rounded-xl border px-3 py-2.5 text-center text-sm font-semibold uppercase tracking-wide transition-colors disabled:cursor-wait disabled:opacity-50 sm:flex-none ${
                      asset === 'btc'
                        ? 'border-amber-700/50 bg-amber-950/30 text-amber-100 hover:bg-amber-950/50'
                        : asset === 'eth'
                          ? 'border-indigo-700/50 bg-indigo-950/30 text-indigo-100 hover:bg-indigo-950/50'
                          : asset === 'sol'
                            ? 'border-violet-700/50 bg-violet-950/30 text-violet-100 hover:bg-violet-950/50'
                            : 'border-emerald-700/45 bg-emerald-950/20 text-emerald-100 hover:bg-emerald-950/35'
                    }`}
                  >
                    {busy ? '…' : `${asset} ${interval}`}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[10px] leading-snug text-zinc-600">
              {interval} Up/Down — BTC/ETH/SOL windows.
            </p>
          </div>
        ))}
        <div className="flex flex-col gap-2 sm:flex-row">
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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
        {marketsListLoading ? (
          <div className="p-4 text-sm leading-relaxed text-zinc-400">Loading markets…</div>
        ) : markets.length === 0 ? (
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
    </>
  );

  return (
      <div className="min-h-full bg-zinc-950 bg-[radial-gradient(100%_60%_at_50%_-10%,rgba(99,102,241,0.08),transparent_52%),linear-gradient(180deg,#0b0b0f_0%,#09090b_45%,#060608_100%)] font-sans text-zinc-200 antialiased">
      <div
        className={`mx-auto px-4 py-8 transition-[padding,max-width] duration-200 ease-out sm:px-6 lg:px-8 ${
          tradeSlideReservesSpace ? 'w-full max-w-none' : 'max-w-7xl'
        }`}
        style={
          tradeSlideReservesSpace
            ? {
                paddingRight: `max(1rem, min(${TRADE_SLIDE_PANEL_WIDTH_PX}px, 100vw))`,
              }
            : undefined
        }
      >
        <header className="rounded-2xl border border-zinc-800/50 bg-zinc-900/20 px-5 py-5 shadow-lg shadow-black/20 ring-1 ring-white/[0.03] backdrop-blur-sm sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-50 sm:text-[1.65rem]">Polymarket order flow</h1>
              <p className="mt-1 text-sm text-zinc-500">Live CLOB ladders and a small assistant for reading the book.</p>
              <p className="mt-2 max-w-2xl text-[12px] leading-relaxed text-zinc-500">{STREAM_ATTRIBUTION_LINE}</p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              {tradeAccountMode === 'live' ? (
                <span
                  className="inline-flex min-h-[34px] items-center gap-1.5 rounded-full border border-rose-500/45 bg-rose-950/40 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.14em] text-rose-100 shadow-sm shadow-rose-950/30 ring-1 ring-rose-400/20"
                  title="Trade panel is in Live mode — orders use real USDC"
                >
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-400" aria-hidden />
                  Live
                </span>
              ) : null}
              <div className="flex flex-wrap items-center gap-1 rounded-full border border-zinc-700/45 bg-zinc-950/55 p-1">
                <button
                  type="button"
                  onClick={() => setTradeUiPref({ embedded: !tradeUiPrefs.embedded })}
                  className={`min-h-[30px] rounded-full px-2.5 text-[10px] font-bold uppercase tracking-wide transition-colors ${
                    tradeUiPrefs.embedded
                      ? 'bg-zinc-800 text-zinc-100 ring-1 ring-zinc-600/50'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                  title="Docked trade panel in the right column (classic layout)"
                >
                  Dock
                </button>
                <button
                  type="button"
                  onClick={() => setTradeUiPref({ slide: !tradeUiPrefs.slide })}
                  className={`min-h-[30px] rounded-full px-2.5 text-[10px] font-bold uppercase tracking-wide transition-colors ${
                    tradeUiPrefs.slide
                      ? 'bg-amber-500/20 text-amber-100 ring-1 ring-amber-500/35'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                  title="Slide-in trade panel from the right (Trade button)"
                >
                  Slide
                </button>
              </div>
              <button
                type="button"
                onClick={openTradeUi}
                className={`min-h-[34px] rounded-full border px-4 text-[12px] font-black tracking-wide shadow-lg shadow-black/20 ring-1 ring-white/[0.04] transition-colors ${
                  tradeAccountMode === 'live'
                    ? 'border-rose-500/40 bg-rose-950/50 text-rose-50 hover:bg-rose-950/65'
                    : 'border-amber-500/35 bg-zinc-950/70 text-amber-100 hover:bg-zinc-900/80'
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
              {booksWsStatus ? (
                <div className="rounded-full border border-zinc-700/40 bg-zinc-950/50 px-3 py-1.5 font-mono text-[11px] leading-snug text-zinc-400">
                  CLOB WS {booksWsStatus}
                </div>
              ) : null}
              {rtdsError ? (
                <div className="rounded-full border border-rose-800/40 bg-rose-950/20 px-3 py-1.5 font-mono text-[11px] leading-snug text-rose-100">
                  RTDS error: {rtdsError}
                </div>
              ) : null}
              {ptbError ? (
                <div className="rounded-full border border-amber-800/40 bg-amber-950/20 px-3 py-1.5 font-mono text-[11px] leading-snug text-amber-100/90">
                  PTB error: {ptbError}
                </div>
              ) : null}
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
          <div
            className={`rounded-2xl border border-zinc-800/50 bg-zinc-950/40 p-5 shadow-lg shadow-black/25 ring-1 ring-white/[0.02] backdrop-blur-sm xl:col-span-3 ${
              mainTab === 'signals' ? 'order-2 xl:order-1' : ''
            }`}
          >
            {mobileLayout ? (
              <details
                open={mobileMarketPanelOpen}
                onToggle={(e) => setMobileMarketPanelOpen(e.currentTarget.open)}
                className="-m-1 overflow-hidden rounded-2xl"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-1 py-1 text-left [&::-webkit-details-marker]:hidden">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Market controls</div>
                    <div className="mt-1 text-sm font-semibold text-zinc-100">
                      {selectedSlug.trim() ? 'Current market ready' : 'Open market, shortcuts, and search'}
                    </div>
                    <div className="mt-1 truncate text-[11px] text-zinc-500">
                      {selectedSlug.trim() || 'Choose a shortcut or search result'}
                    </div>
                  </div>
                  <span className="rounded-full border border-zinc-700/50 bg-zinc-900/35 px-3 py-1 text-[11px] font-semibold text-zinc-300">
                    {mobileMarketPanelOpen ? 'Hide' : 'Show'}
                  </span>
                </summary>
                <div className="mt-3 border-t border-zinc-800/50 pt-4">{marketControls}</div>
              </details>
            ) : (
              marketControls
            )}
          </div>

          <div
            className={`min-w-0 max-w-full rounded-2xl border border-zinc-800/50 bg-zinc-950/40 p-4 shadow-lg shadow-black/25 ring-1 ring-white/[0.02] backdrop-blur-sm sm:p-5 ${
              showEmbeddedTradeDock ? 'xl:col-span-7' : 'xl:col-span-9'
            } ${mainTab === 'signals' ? 'order-1 xl:order-2' : ''}`}
          >
            <div className="flex flex-col gap-3 border-b border-zinc-800/40 pb-3 sm:flex-row sm:flex-wrap sm:items-center">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <div className="text-[15px] font-semibold text-zinc-100">{mainTabTitle(mainTab)}</div>
                <div className="min-w-0 max-w-full truncate rounded-md bg-zinc-900/50 px-2 py-0.5 font-mono text-xs text-zinc-400">
                  {selectedSlug || '—'}
                </div>
                {booksLoading ? (
                  <div className="rounded-full bg-indigo-500/15 px-2.5 py-0.5 text-xs font-medium text-indigo-200/90">Loading…</div>
                ) : null}
              </div>

              <div className="flex items-center gap-2 sm:ml-auto">
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
                  onClick={openTradeUi}
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

            <div className="-mx-1 mt-4 overflow-x-auto pb-1 [scrollbar-width:none]">
              <div className="flex min-w-max gap-x-0.5 gap-y-0 border-b border-zinc-800/80 px-1">
                <MainTabButton id="book" label="Book" active={mainTab === 'book'} onSelect={setMainTab} />
                <MainTabButton id="flowzones" label="Flow" title="Flow Zones" active={mainTab === 'flowzones'} onSelect={setMainTab} />
                <MainTabButton id="signals" label="Signals" active={mainTab === 'signals'} onSelect={setMainTab} />
                <MainTabButton id="tracking" label="Tracking" title="Positions + open orders + cash" active={mainTab === 'tracking'} onSelect={setMainTab} />
                <MainTabButton id="tradehistory" label="History" title="Trade history (paper + live log)" active={mainTab === 'tradehistory'} onSelect={setMainTab} />
                <MainTabButton id="btc" label="BTC" title="BTC live spot + paper trading" active={mainTab === 'btc'} onSelect={setMainTab} />
                <MainTabButton
                  id="tvbtc"
                  label="BTC/USDT"
                  title="Binance BTCUSDT spot — full dollar price & TradingView (not Polymarket share prices)"
                  active={mainTab === 'tvbtc'}
                  onSelect={setMainTab}
                />
                <MainTabButton
                  id="perps"
                  label="Perps"
                  title="Perps Trade Command Center — BTC/ETH/SOL charts, bias, SL/TP, liq, funding, sizing"
                  active={mainTab === 'perps'}
                  onSelect={setMainTab}
                />
                <MainTabButton id="multiscan" label="Multi" title="Multi-asset PTB scan" active={mainTab === 'multiscan'} onSelect={setMainTab} />
                <MainTabButton id="assistant" label="Assistant" active={mainTab === 'assistant'} onSelect={setMainTab} />
                <MainTabButton id="raw" label="Raw" active={mainTab === 'raw'} onSelect={setMainTab} />
              </div>
            </div>

            {binanceSpotActive ? (
              <div className="mt-3 rounded-xl border border-cyan-800/45 bg-cyan-950/25 px-3 py-2 text-[11px] leading-relaxed text-cyan-50/95">
                <span className="font-semibold">Binance BTC/USDT spot market</span> — Book, Flow, and Signals use live depth and agg trades from your API. Polymarket CLOB polling is paused until you exit.
              </div>
            ) : null}

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
                    {updownParsed.interval === '1h'
                      ? 'Hour markers'
                      : updownParsed.interval === '15m'
                        ? '15-minute markers'
                        : updownParsed.interval === '4h'
                          ? '4-hour markers'
                          : updownParsed.interval === '1d'
                            ? 'Daily markers'
                            : '5-minute markers'}
                    <span className="ml-2 font-mono text-zinc-500">({updownParsed.asset.toUpperCase()} {updownParsed.interval})</span>
                  </div>
                  {parseUpdownSlug(selectedSlug) ? (
                    <button
                      type="button"
                      onClick={() => setUpdownPickerOpen((v) => !v)}
                      className="rounded-lg border border-zinc-700/60 bg-black/20 px-2.5 py-1.5 text-[11px] font-bold text-zinc-200 hover:bg-black/30"
                      title="Jump to an exact window boundary"
                    >
                      {updownPickerOpen ? 'Hide' : 'Choose window'}
                    </button>
                  ) : isShortcutAsset(updownParsed.asset as UpdownShortcutAsset) ? (
                    <button
                      type="button"
                      onClick={() =>
                        void openUpdownShortcut(updownParsed.asset as UpdownShortcutAsset, updownParsed.interval)
                      }
                      className="rounded-lg border border-zinc-700/60 bg-black/20 px-2.5 py-1.5 text-[11px] font-bold text-zinc-200 hover:bg-black/30"
                      title="Reload the live window from Polymarket"
                    >
                      Live {updownParsed.interval}
                    </button>
                  ) : null}
                </div>

                {updownPickerOpen && parseUpdownSlug(selectedSlug) ? (
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

            {tokenIds.length === 0 &&
            !binanceSpotActive &&
            mainTab !== 'tradehistory' &&
            mainTab !== 'btc' &&
            mainTab !== 'tvbtc' &&
            mainTab !== 'perps' ? (
              <div className="mt-4 text-sm leading-relaxed text-zinc-500">Select a market to load token ids and ladders.</div>
            ) : null}

            {error ? (
              <pre className="mt-4 overflow-auto rounded-xl border border-red-800/30 bg-red-950/15 p-3 text-xs leading-relaxed text-red-200/90">{error}</pre>
            ) : null}

            {binanceSpotActive && (mainTab === 'book' || mainTab === 'flowzones' || mainTab === 'signals') ? (
              <BinanceBtcUsdtMarketView
                mainTab={mainTab}
                chartEnabled={chartEnabled}
                setChartEnabled={setChartEnabled}
                flowMode={flowMode}
                setFlowMode={setFlowMode}
                onClose={() => setBinanceSpotActive(false)}
              />
            ) : null}

            {!binanceSpotActive && mainTab === 'book' ? (
              <div className="mt-5">
                <div className="mb-4 rounded-2xl border border-zinc-800/40 bg-zinc-900/20 p-3 ring-1 ring-white/[0.02]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Outcome mids</div>
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

            {mainTab === 'btc' ? <BtcSpotPaperTest /> : null}

            {mainTab === 'tvbtc' ? <TradingViewBtcUsdtTab /> : null}

            {mainTab === 'perps' ? <PerpsCommandCenter /> : null}

            {!binanceSpotActive && mainTab === 'flowzones' ? (
              <div className="mt-5">
                <Suspense fallback={tabSuspenseFallback}>
                  <FlowZonesTab
                    key={selectedSlug ?? ''}
                    market={marketJson}
                    books={books}
                    outcomeLabels={outcomeLabels}
                    flowSeriesForSlug={flowSeriesBySlug[selectedSlug] ?? null}
                    booksFetchedAt={booksFetchedAt}
                    priceToBeatUsd={ssrPriceToBeat}
                    endsInMs={marketEndsInMs}
                  />
                </Suspense>
              </div>
            ) : null}

            {!binanceSpotActive && mainTab === 'signals' ? (
              <div className="mt-5">
                {shortcutBusy && !selectedSlug.trim() ? (
                  <div className="mb-4 rounded-2xl border border-indigo-800/40 bg-indigo-950/20 px-4 py-6 text-center text-sm text-indigo-100/90">
                    Loading {shortcutBusy.asset.toUpperCase()} {shortcutBusy.interval} market…
                  </div>
                ) : !selectedSlug.trim() ? (
                  <div className="mb-4 rounded-2xl border border-amber-800/35 bg-amber-950/15 px-4 py-4 text-sm leading-relaxed text-amber-100/90">
                    <p className="font-semibold text-amber-50">Pick a market to load signals</p>
                    <p className="mt-2 text-amber-100/75">
                      Tap a <span className="font-medium text-amber-50">BTC / ETH / SOL / HYPE</span> shortcut on the left (5m is fastest), or paste a slug, then stay on this tab.
                    </p>
                  </div>
                ) : booksLoading && !books ? (
                  <div className="mb-4 rounded-2xl border border-zinc-800/60 bg-zinc-950/40 px-4 py-6 text-center text-sm text-zinc-400">
                    Loading order books for signals…
                  </div>
                ) : null}
                {error && selectedSlug.trim() && !marketJson ? (
                  <div className="mb-4 rounded-2xl border border-amber-800/40 bg-amber-950/20 px-4 py-4 text-sm leading-relaxed text-amber-100/90">
                    <p className="font-semibold text-amber-50">Market metadata did not load</p>
                    <p className="mt-2 text-amber-100/75">
                      Slug <span className="font-mono text-amber-50/95">{selectedSlug}</span> is set, but the API could not
                      fetch Gamma/CLOB details (often a brief upstream blip). Retrying automatically — or tap Retry.
                    </p>
                    {apiHealth.includes('Gamma unreachable') ? (
                      <p className="mt-2 text-[12px] text-amber-200/70">
                        Header shows Gamma unreachable — check the API terminal and your network, then retry.
                      </p>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void loadMarket(selectedSlug.trim())}
                      className="mt-3 rounded-xl border border-amber-600/50 bg-amber-950/40 px-4 py-2 text-xs font-semibold text-amber-50 hover:bg-amber-950/55"
                    >
                      Retry load
                    </button>
                  </div>
                ) : null}
                {selectedSlug.trim() && ssrPriceToBeat == null && ptbError ? (
                  <div className="mb-4 rounded-2xl border border-amber-800/40 bg-amber-950/20 px-4 py-4 text-sm leading-relaxed text-amber-100/90">
                    <p className="font-semibold text-amber-50">Price-to-beat (PTB) not loaded yet</p>
                    <p className="mt-2 text-amber-100/75">
                      The yellow PTB line and spot-vs-bell signals need SSR or Chainlink bucket price from the API.
                      Retrying every few seconds — chart may show a placeholder scale until PTB arrives.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        const slug = selectedSlug.trim();
                        if (!slug) return;
                        void priceToBeat(slug).then((ptb) => {
                          if (!isOk(ptb)) {
                            setPtbError(pretty(ptb));
                            return;
                          }
                          setSsrPriceToBeat(ptb.data.price_to_beat);
                          setSsrPtbSource(ptb.data.source);
                          setPtbError(null);
                        });
                      }}
                      className="mt-3 rounded-xl border border-amber-600/50 bg-amber-950/40 px-4 py-2 text-xs font-semibold text-amber-50 hover:bg-amber-950/55"
                    >
                      Retry PTB
                    </button>
                  </div>
                ) : null}
                <SignalsPtbOnly
                  key={selectedSlug ?? ''}
                  slug={selectedSlug}
                  market={marketJson}
                  books={books}
                  outcomeLabels={outcomeLabels}
                  priceToBeat={ssrPriceToBeat}
                  spot={spotSeriesBySlug[selectedSlug] ?? []}
                  spotLastUpdateMs={signalsSpotFeedLastMs}
                  probUp={signalsProbMids.up}
                  probDown={signalsProbMids.down}
                  probLastUpdateMs={signalsProbFeedLastMs}
                  flowSeriesForSlug={flowSeriesBySlug[selectedSlug] ?? null}
                  endsInMs={marketEndsInMs}
                  booksFetchedAt={booksFetchedAt}
                  spotStreamEligible={isUpdownDeskMarket(selectedSlug, updownSlugHints)}
                  ptbSource={ssrPtbSource}
                  spotFeedSource={rtdsSpotFeedSource}
                  onOpenTradeHistory={() => setMainTab('tradehistory')}
                  tradePanelSlug={effectiveTradeContext.slug}
                  tradePanelLane={globalTradeLane}
                  tradePanelPinned={globalTradeLocked}
                />
                <p className="mt-3 text-center text-[11px] text-zinc-600">
                  Book tab: order flow, ladders, and above/below context. Assistant tab: chat + digest.
                </p>
              </div>
            ) : null}

            {mainTab === 'tracking' ? (
              binanceSpotActive ? (
                <div className="mt-5 rounded-2xl border border-zinc-800/50 bg-zinc-950/35 p-5 text-sm leading-relaxed text-zinc-400">
                  <span className="font-semibold text-zinc-200">Tracking</span> is for Polymarket positions and open orders. Exit the Binance spot workspace (Book → Exit spot market, or load a Polymarket slug) to use Tracking for your event.
                </div>
              ) : (
                <Suspense fallback={tabSuspenseFallback}>
                <TrackingTab
                  upToken={effectiveTradeContext.upToken}
                  downToken={effectiveTradeContext.downToken}
                  conditionId={trackingConditionId}
                  upLabel={effectiveTradeContext.upLabel}
                  downLabel={effectiveTradeContext.downLabel}
                  slug={effectiveTradeContext.slug}
                  upMid01={tradePanelBookMids.up}
                  downMid01={tradePanelBookMids.down}
                  onOpenTradeHistory={() => setMainTab('tradehistory')}
                  onOpenSignals={() => setMainTab('signals')}
                />
                </Suspense>
              )
            ) : null}

            {mainTab === 'tradehistory' ? (
              <div className="mt-5">
                <Suspense fallback={tabSuspenseFallback}>
                  <TradeHistoryTab />
                </Suspense>
              </div>
            ) : null}

            {mainTab === 'multiscan' ? (
              <div className="mt-5">
                <Suspense fallback={tabSuspenseFallback}>
                <PtbMultiAssetGrid
                  rows={multiScanRows}
                  onOpenSlug={(slug) => {
                    void loadMarket(slug);
                    setMainTab('signals');
                  }}
                  onAddMarkets={() => {
                    const s = selectedSlug.trim();
                    if (!s) return;
                    setPtbWatchSlugs((prev) => (prev.includes(s) ? prev : [...prev, s].slice(-12)));
                  }}
                />
                </Suspense>
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

            {showEmbeddedTradeDock ? (
              <div className="mt-5 xl:hidden">
                <TradePanelShell>
                  <TradePanelBody
                    title="Docked trade"
                    subtitle="Full order entry — same controls as the right column on desktop."
                    enabled={effectiveTradeEnabled}
                    ready={effectiveTradeReady}
                    panelProps={tradePanelSharedProps}
                    visualStyle="default"
                  />
                </TradePanelShell>
              </div>
            ) : null}
          </div>

          {showEmbeddedTradeDock ? (
            <div className="hidden xl:col-span-2 xl:block">
              <div className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto overscroll-y-contain [-ms-overflow-style:none] [scrollbar-width:thin]">
                <TradePanelShell>
                  <TradePanelBody
                    title="Docked trade"
                    subtitle="Classic sidebar — lane, size, brackets, and orders while you read charts."
                    enabled={effectiveTradeEnabled}
                    ready={effectiveTradeReady}
                    panelProps={tradePanelSharedProps}
                    visualStyle="default"
                  />
                </TradePanelShell>
              </div>
            </div>
          ) : null}
        </div>

        {tradeUiPrefs.slide ? (
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
              <div className="space-y-2 border-t border-zinc-800/50 px-3 py-3">
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
              <SignalsTradePanel {...tradePanelSharedProps} visualStyle="slide" />
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
              </div>
            )}
          </div>
        </TradeSlidePanel>
        ) : null}

        {positionsPanelOpen ? (
          <Suspense fallback={null}>
            <PositionsCommandPanel
              open={positionsPanelOpen}
              onClose={() => setPositionsPanelOpen(false)}
              selectedSlug={selectedSlug}
              booksFetchedAt={booksFetchedAt}
              onNavigate={(slug, lane) => {
                void loadMarket(slug);
                setGlobalTradeLane(lane);
                setMainTab('signals');
              }}
            />
          </Suspense>
        ) : null}
      </div>
      </div>
  );
}

export default App;
