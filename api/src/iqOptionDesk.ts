/**
 * IQ Option Bitcoin (BTCX) practice desk — live candles + turbo binary on demo balance.
 * Requires IQ_OPTION_EMAIL + IQ_OPTION_PASSWORD in api/.env (your IQ Option login).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const IQ = require('iq-option-client') as typeof import('iq-option-client');

export const IQ_BITCOIN_ACTIVE_ID = IQ.IQOptionMarket.BTCX; // 73

export type IqOptionDeskCandle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  closed: boolean;
  bid: number | null;
  ask: number | null;
};

export type IqOptionDeskSnapshot = {
  connected: boolean;
  configured: boolean;
  error: string | null;
  market: 'BTCX';
  activeId: number;
  barSec: number;
  livePrice: number | null;
  bid: number | null;
  ask: number | null;
  practiceBalanceUsd: number | null;
  practiceBalanceId: number | null;
  candles: IqOptionDeskCandle[];
  updatedAt: number;
};

type StreamHandle = {
  barSec: number;
  stream: InstanceType<typeof IQ.IQOptionStreamCandleGenerated>;
  candles: IqOptionDeskCandle[];
  lastCandleId: number | null;
};

let api: InstanceType<typeof IQ.IQOptionApi> | null = null;
let connectPromise: Promise<void> | null = null;
let practiceBalanceId: number | null = null;
let practiceBalanceUsd: number | null = null;
let lastError: string | null = null;
let activeStream: StreamHandle | null = null;

function credentialsConfigured(): boolean {
  const email = process.env.IQ_OPTION_EMAIL?.trim();
  const password = process.env.IQ_OPTION_PASSWORD?.trim();
  return Boolean(email && password);
}

function iqTimeMinutesForBarSec(barSec: number): number {
  return Math.max(1, Math.round(barSec / 60));
}

function toDeskCandle(c: {
  from: number;
  open: number;
  close: number;
  max: number;
  min: number;
  volume: number;
  bid: number;
  ask: number;
  phase?: string;
}): IqOptionDeskCandle {
  const closed = c.phase !== 'T';
  return {
    t: c.from * 1000,
    o: c.open,
    h: c.max,
    l: c.min,
    c: c.close,
    v: c.volume,
    closed,
    bid: Number.isFinite(c.bid) ? c.bid : null,
    ask: Number.isFinite(c.ask) ? c.ask : null,
  };
}

async function ensureConnected(): Promise<InstanceType<typeof IQ.IQOptionApi>> {
  if (!credentialsConfigured()) {
    throw new Error('IQ Option not configured — set IQ_OPTION_EMAIL and IQ_OPTION_PASSWORD in api/.env');
  }
  if (api) return api;
  if (connectPromise) {
    await connectPromise;
    if (api) return api;
    throw new Error(lastError ?? 'IQ Option connect failed');
  }

  connectPromise = (async () => {
    try {
      const email = process.env.IQ_OPTION_EMAIL!.trim();
      const password = process.env.IQ_OPTION_PASSWORD!.trim();
      const client = new IQ.IQOptionApi(email, password);
      const profile = await client.connectAsync();
      const practice = profile.balances?.find((b) => b.type === IQ.IQOptionCurrencyType.TEST);
      practiceBalanceId = practice?.id ?? null;
      practiceBalanceUsd = practice?.amount ?? null;
      api = client;
      lastError = null;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      api = null;
      throw e;
    } finally {
      connectPromise = null;
    }
  })();

  await connectPromise;
  if (!api) throw new Error(lastError ?? 'IQ Option connect failed');
  return api;
}

async function stopStream(): Promise<void> {
  if (!activeStream) return;
  try {
    activeStream.stream.destroy();
  } catch {
    /* ignore */
  }
  activeStream = null;
}

async function seedHistory(client: InstanceType<typeof IQ.IQOptionApi>, barSec: number, handle: StreamHandle): Promise<void> {
  const lastId = handle.lastCandleId;
  if (lastId == null) return;
  try {
    const fromId = Math.max(1, lastId - 80);
    const rows = await client.getCandles(IQ_BITCOIN_ACTIVE_ID, barSec, fromId, lastId + 2, true, false, 20_000);
    if (!Array.isArray(rows) || rows.length === 0) return;
    const mapped = rows.map((c) => toDeskCandle(c));
    handle.candles = mapped.slice(-48);
  } catch {
    /* stream will backfill */
  }
}

async function ensureStream(barSec: number): Promise<StreamHandle> {
  const client = await ensureConnected();
  if (activeStream && activeStream.barSec === barSec) return activeStream;

  await stopStream();

  const iqMinutes = iqTimeMinutesForBarSec(barSec);
  const stream = new IQ.IQOptionStreamCandleGenerated(
    client.getIQOptionWs(),
    IQ_BITCOIN_ACTIVE_ID,
    iqMinutes,
  );

  const handle: StreamHandle = { barSec, stream, candles: [], lastCandleId: null };

  stream.on('data', (candle: Parameters<typeof toDeskCandle>[0] & { id: number }) => {
    handle.lastCandleId = candle.id;
    const row = toDeskCandle(candle);
    const idx = handle.candles.findIndex((x) => x.t === row.t);
    if (idx >= 0) handle.candles[idx] = row;
    else handle.candles.push(row);
    handle.candles = handle.candles.slice(-48);
  });

  await stream.startStream();
  activeStream = handle;

  // Give stream a moment, then backfill history if we have ids
  await new Promise((r) => setTimeout(r, 1200));
  if (handle.lastCandleId != null) await seedHistory(client, barSec, handle);

  return handle;
}

export function iqOptionConfigured(): boolean {
  return credentialsConfigured();
}

export async function getIqOptionSnapshot(barSec: number): Promise<IqOptionDeskSnapshot> {
  if (!credentialsConfigured()) {
    return {
      connected: false,
      configured: false,
      error: 'Add IQ_OPTION_EMAIL and IQ_OPTION_PASSWORD to api/.env (IQ Option practice account login).',
      market: 'BTCX',
      activeId: IQ_BITCOIN_ACTIVE_ID,
      barSec,
      livePrice: null,
      bid: null,
      ask: null,
      practiceBalanceUsd,
      practiceBalanceId,
      candles: [],
      updatedAt: Date.now(),
    };
  }

  try {
    await ensureConnected();
    const handle = await ensureStream(barSec);
    const last = handle.candles[handle.candles.length - 1] ?? null;
    const livePrice = last?.c ?? null;
    return {
      connected: true,
      configured: true,
      error: null,
      market: 'BTCX',
      activeId: IQ_BITCOIN_ACTIVE_ID,
      barSec,
      livePrice,
      bid: last?.bid ?? null,
      ask: last?.ask ?? null,
      practiceBalanceUsd,
      practiceBalanceId,
      candles: [...handle.candles],
      updatedAt: Date.now(),
    };
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    return {
      connected: false,
      configured: true,
      error: lastError,
      market: 'BTCX',
      activeId: IQ_BITCOIN_ACTIVE_ID,
      barSec,
      livePrice: null,
      bid: null,
      ask: null,
      practiceBalanceUsd,
      practiceBalanceId,
      candles: activeStream?.candles ?? [],
      updatedAt: Date.now(),
    };
  }
}

export async function placeIqOptionBinaryOrder(input: {
  direction: 'up' | 'down';
  amountUsd: number;
  expiryMin: number;
}): Promise<{ ok: true; optionId: number } | { ok: false; error: string }> {
  try {
    const client = await ensureConnected();
    if (practiceBalanceId == null) {
      return { ok: false, error: 'IQ Option practice balance not found on this account.' };
    }
    const amount = input.amountUsd;
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: 'Invalid stake amount.' };
    }
    const mins = Math.min(15, Math.max(1, Math.round(input.expiryMin)));
    const side = input.direction === 'up' ? IQ.IQOptionModel.BUY : IQ.IQOptionModel.SELL;
    const expiry = IQ.iqOptionExpired(mins);
    const opened = await client.sendOrderBinary(
      IQ_BITCOIN_ACTIVE_ID,
      side,
      expiry,
      practiceBalanceId,
      85,
      amount,
    );
    if (practiceBalanceUsd != null && Number.isFinite(practiceBalanceUsd)) {
      practiceBalanceUsd = Math.max(0, practiceBalanceUsd - amount);
    }
    return { ok: true, optionId: opened.option_id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
