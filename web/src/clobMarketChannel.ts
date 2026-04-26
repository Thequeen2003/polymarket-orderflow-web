export type ClobWsBookLevel = { price: string; size: string };

export type ClobWsBookMsg = {
  event_type: 'book';
  asset_id: string;
  bids: ClobWsBookLevel[];
  asks: ClobWsBookLevel[];
  timestamp?: string;
  hash?: string;
};

export type ClobWsPriceChange = {
  asset_id: string;
  price: string;
  size: string;
  side: 'BUY' | 'SELL';
  best_bid?: string;
  best_ask?: string;
};

export type ClobWsPriceChangeMsg = {
  event_type: 'price_change';
  price_changes: ClobWsPriceChange[];
  timestamp?: string;
};

export type ClobWsBestBidAskMsg = {
  event_type: 'best_bid_ask';
  asset_id: string;
  best_bid: string;
  best_ask: string;
  timestamp?: string;
};

export type ClobWsMsg = ClobWsBookMsg | ClobWsPriceChangeMsg | ClobWsBestBidAskMsg | { event_type: string } | unknown;

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

export function openClobMarketChannel(params: {
  assetIds: string[];
  onBook: (assetId: string, book: { bids: ClobWsBookLevel[]; asks: ClobWsBookLevel[] }) => void;
  onBestBidAsk?: (assetId: string, best: { bestBid: string; bestAsk: string }) => void;
  onPriceChanges?: (changes: ClobWsPriceChange[]) => void;
  onStatus?: (s: { state: 'open' | 'closed' | 'error'; detail?: string }) => void;
}): { close: () => void } {
  const ws = new WebSocket(WS_URL);
  let closed = false;
  let pongTimer: number | null = null;
  let lastMsgAt = Date.now();

  const safeStatus = (s: { state: 'open' | 'closed' | 'error'; detail?: string }) => {
    try {
      params.onStatus?.(s);
    } catch {
      /* ignore */
    }
  };

  ws.addEventListener('open', () => {
    if (closed) return;
    safeStatus({ state: 'open' });
    ws.send(
      JSON.stringify({
        type: 'market',
        assets_ids: params.assetIds,
        custom_feature_enabled: true,
      }),
    );

    // Keepalive: some networks/proxies silently drop idle WS.
    // Also detect a "stalled" connection (open but no messages) and surface it.
    if (pongTimer != null) window.clearInterval(pongTimer);
    pongTimer = window.setInterval(() => {
      if (closed) return;
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      } catch {
        /* ignore */
      }
      const ageMs = Date.now() - lastMsgAt;
      if (ageMs > 30_000) safeStatus({ state: 'error', detail: `ws_stalled_${ageMs}ms` });
    }, 10_000);
  });

  ws.addEventListener('message', (ev) => {
    if (closed) return;
    lastMsgAt = Date.now();
    let msg: ClobWsMsg = ev.data;
    try {
      if (typeof ev.data === 'string') msg = JSON.parse(ev.data) as ClobWsMsg;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const o = msg as Record<string, unknown>;
    const t = String(o.event_type ?? '');
    if (t === 'pong') return;
    if (t === 'book') {
      const m = msg as ClobWsBookMsg;
      if (!m.asset_id) return;
      params.onBook(m.asset_id, { bids: Array.isArray(m.bids) ? m.bids : [], asks: Array.isArray(m.asks) ? m.asks : [] });
      return;
    }
    if (t === 'price_change') {
      const m = msg as ClobWsPriceChangeMsg;
      const changes = Array.isArray(m.price_changes) ? m.price_changes : [];
      if (changes.length) params.onPriceChanges?.(changes);
      return;
    }
    if (t === 'best_bid_ask') {
      const m = msg as ClobWsBestBidAskMsg;
      if (!m.asset_id) return;
      params.onBestBidAsk?.(m.asset_id, { bestBid: m.best_bid, bestAsk: m.best_ask });
    }
  });

  ws.addEventListener('close', () => {
    if (closed) return;
    safeStatus({ state: 'closed' });
  });
  ws.addEventListener('error', () => {
    if (closed) return;
    safeStatus({ state: 'error', detail: 'ws_error' });
  });

  return {
    close: () => {
      closed = true;
      if (pongTimer != null) window.clearInterval(pongTimer);
      pongTimer = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      safeStatus({ state: 'closed' });
    },
  };
}

