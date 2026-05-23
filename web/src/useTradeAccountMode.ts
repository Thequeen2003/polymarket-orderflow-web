import { useEffect, useState } from 'react';
import {
  loadTradeAccountMode,
  TRADE_ACCOUNT_MODE_EVENT,
  type TradeAccountMode,
} from './tradeAccountMode';

export function useTradeAccountMode(): TradeAccountMode {
  const [mode, setMode] = useState<TradeAccountMode>(() => loadTradeAccountMode());
  useEffect(() => {
    const onChange = (ev: Event) => {
      const ce = ev as CustomEvent<{ mode?: TradeAccountMode }>;
      if (ce.detail?.mode === 'live' || ce.detail?.mode === 'paper') setMode(ce.detail.mode);
      else setMode(loadTradeAccountMode());
    };
    const onStorage = () => setMode(loadTradeAccountMode());
    window.addEventListener(TRADE_ACCOUNT_MODE_EVENT, onChange as EventListener);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(TRADE_ACCOUNT_MODE_EVENT, onChange as EventListener);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return mode;
}
