import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

type TradeFloatChromeApi = {
  /** Pin UI below the floating trade title row (does not scroll with panel body). */
  setSubHeader: (node: ReactNode) => void;
};

const TradeFloatChromeContext = createContext<TradeFloatChromeApi | null>(null);

export function TradeFloatChromeProvider(props: {
  value: TradeFloatChromeApi;
  children: ReactNode;
}): ReactElement {
  return <TradeFloatChromeContext.Provider value={props.value}>{props.children}</TradeFloatChromeContext.Provider>;
}

/** Only available inside {@link TradeSlidePanel} — pins tab strip under the slide header. */
export function useTradeFloatChrome(): TradeFloatChromeApi | null {
  return useContext(TradeFloatChromeContext);
}
