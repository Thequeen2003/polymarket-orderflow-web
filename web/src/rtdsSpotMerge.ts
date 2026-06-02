import type { RtdsCryptoPoint } from './lib/api';
import type { SpotPoint } from './SpotLevelChart';

/** Chainlink USD prints carry more precision than Binance USDT mirrors. */
export function looksLikeChainlinkUsd(v: number): boolean {
  if (!Number.isFinite(v)) return false;
  const frac = String(v).split('.')[1]?.replace(/0+$/, '') ?? '';
  return frac.length >= 3;
}

export function acceptChainlinkUsdSpot(v: number, src?: string): boolean {
  if (!Number.isFinite(v)) return false;
  if (src === 'chainlink') return true;
  if (src === 'binance') return false;
  return looksLikeChainlinkUsd(v);
}

function pickPreferredSpot(a: SpotPoint, b: SpotPoint): SpotPoint {
  const aCl = looksLikeChainlinkUsd(a.v);
  const bCl = looksLikeChainlinkUsd(b.v);
  if (aCl && !bCl) return a;
  if (bCl && !aCl) return b;
  const aFrac = String(a.v).split('.')[1]?.replace(/0+$/, '').length ?? 0;
  const bFrac = String(b.v).split('.')[1]?.replace(/0+$/, '').length ?? 0;
  return bFrac >= aFrac ? b : a;
}

/** Merge RTDS poll payloads into a monotonic spot series; slash-USD uses Chainlink-only ticks. */
export function mergeSpotHistory(
  prev: SpotPoint[],
  data: { value: number; ts: number; source?: string; history?: RtdsCryptoPoint[] },
  symbol?: string,
): SpotPoint[] {
  const chainlinkOnly = symbol?.endsWith('/usd') ?? false;
  const serverTs = Number.isFinite(data.ts) ? data.ts : Date.now();
  const serverV = Number.isFinite(data.value) ? data.value : NaN;
  const hist = data.history;
  const fromHist: SpotPoint[] =
    Array.isArray(hist) && hist.length > 0
      ? hist
          .filter((q) => typeof q.t === 'number' && typeof q.v === 'number' && Number.isFinite(q.t) && Number.isFinite(q.v))
          .filter((q) => !chainlinkOnly || acceptChainlinkUsdSpot(q.v, q.src))
          .map((q) => ({ t: q.t, v: q.v }))
          .sort((a, b) => a.t - b.t)
      : [];

  const basePrev = chainlinkOnly ? prev.filter((p) => acceptChainlinkUsdSpot(p.v)) : prev;
  const merged = [...basePrev, ...fromHist];
  if (
    Number.isFinite(serverTs) &&
    Number.isFinite(serverV) &&
    (!chainlinkOnly || acceptChainlinkUsdSpot(serverV, data.source))
  ) {
    merged.push({ t: serverTs, v: serverV });
  }
  merged.sort((a, b) => a.t - b.t);

  const out: SpotPoint[] = [];
  let lastT: number | null = null;
  for (const p of merged) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.v)) continue;
    if (lastT != null && p.t === lastT) {
      out[out.length - 1] = chainlinkOnly ? pickPreferredSpot(out[out.length - 1]!, p) : p;
      continue;
    }
    out.push(p);
    lastT = p.t;
  }
  return out.slice(-900);
}
