import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  BPX_SETTLEMENT_BIAS_OPEN_EVENT,
  settlementBiasSnapshotKey,
  type SettlementBiasSnapshot,
} from './settlementBiasDesk';

type SettlementBiasDeskValue = {
  snapshot: SettlementBiasSnapshot | null;
  publish: (next: SettlementBiasSnapshot | null) => void;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
};

const SettlementBiasDeskContext = createContext<SettlementBiasDeskValue | null>(null);

export function SettlementBiasDeskProvider(props: { children: ReactNode }): ReactElement {
  const [snapshot, setSnapshot] = useState<SettlementBiasSnapshot | null>(null);
  const [open, setOpen] = useState(false);

  const openPanel = useCallback(() => setOpen(true), []);
  const closePanel = useCallback(() => setOpen(false), []);
  const togglePanel = useCallback(() => setOpen((v) => !v), []);
  const snapshotKeyRef = useRef('');
  const publish = useCallback((next: SettlementBiasSnapshot | null) => {
    const key = settlementBiasSnapshotKey(next);
    if (key === snapshotKeyRef.current) return;
    snapshotKeyRef.current = key;
    setSnapshot(next);
  }, []);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(BPX_SETTLEMENT_BIAS_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(BPX_SETTLEMENT_BIAS_OPEN_EVENT, onOpen);
  }, []);

  const value = useMemo(
    () => ({ snapshot, publish, open, setOpen, openPanel, closePanel, togglePanel }),
    [snapshot, publish, open, openPanel, closePanel, togglePanel],
  );

  return <SettlementBiasDeskContext.Provider value={value}>{props.children}</SettlementBiasDeskContext.Provider>;
}

export function useSettlementBiasDesk(): SettlementBiasDeskValue {
  const ctx = useContext(SettlementBiasDeskContext);
  if (!ctx) {
    throw new Error('useSettlementBiasDesk must be used within SettlementBiasDeskProvider');
  }
  return ctx;
}

/** Safe when provider may be absent (e.g. tests). */
export function useSettlementBiasDeskOptional(): SettlementBiasDeskValue | null {
  return useContext(SettlementBiasDeskContext);
}
