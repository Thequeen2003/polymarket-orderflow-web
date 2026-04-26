import {
  cryptoMarkToMarket,
  cryptoPaperTrade,
  freshCryptoPaperAccount,
  getCryptoPaperPosition,
  type CryptoPaperAccount,
  type CryptoPaperTradeResult,
  type CryptoPosition,
  type CryptoTradeSide,
} from './cryptoPaperTradingCore';

export type { CryptoPaperAccount, CryptoPaperTradeResult, CryptoPosition, CryptoTradeSide };
export { cryptoMarkToMarket, freshCryptoPaperAccount, getCryptoPaperPosition };

const STORAGE_KEY = 'pmof.cryptoPaperAccount.v1';

export function loadCryptoPaperAccount(): CryptoPaperAccount {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshCryptoPaperAccount();
    const parsed = JSON.parse(raw) as Partial<CryptoPaperAccount> | null;
    if (!parsed || typeof parsed !== 'object') return freshCryptoPaperAccount();
    const a = freshCryptoPaperAccount();
    const cash = Number(parsed.cashUsdCents);
    const realized = Number(parsed.realizedPnlUsdCents);
    a.cashUsdCents = Number.isFinite(cash) ? cash : a.cashUsdCents;
    a.realizedPnlUsdCents = Number.isFinite(realized) ? realized : a.realizedPnlUsdCents;
    a.positionsBySymbol =
      parsed.positionsBySymbol && typeof parsed.positionsBySymbol === 'object' ? (parsed.positionsBySymbol as any) : {};
    a.updatedAt = typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : Date.now();
    return a;
  } catch {
    return freshCryptoPaperAccount();
  }
}

export function saveCryptoPaperAccount(a: CryptoPaperAccount): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
  } catch {
    /* ignore */
  }
}

export function resetCryptoPaperAccount(): CryptoPaperAccount {
  const next = freshCryptoPaperAccount();
  saveCryptoPaperAccount(next);
  return next;
}

export function cryptoPaperTradeAndPersist(args: {
  account: CryptoPaperAccount;
  symbol: string;
  side: CryptoTradeSide;
  qty: number;
  priceUsd: number | null;
  now?: number;
}): CryptoPaperTradeResult {
  const r = cryptoPaperTrade(args);
  if (!r.ok) return r;
  saveCryptoPaperAccount(r.account);
  return r;
}

