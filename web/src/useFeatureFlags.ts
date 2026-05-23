/**
 * React hook for the persisted feature-flag layer. Subscribes to in-tab
 * `polyof:flags-changed` events so toggling a flag anywhere updates everyone.
 */
import { useEffect, useState } from 'react';
import { readFeatureFlags, type FeatureFlags } from './featureFlags';

export function useFeatureFlags(): FeatureFlags {
  const [flags, setFlags] = useState<FeatureFlags>(() => readFeatureFlags());
  useEffect(() => {
    const handler = (ev: Event) => {
      const ce = ev as CustomEvent<FeatureFlags>;
      if (ce.detail) setFlags(ce.detail);
      else setFlags(readFeatureFlags());
    };
    window.addEventListener('polyof:flags-changed', handler as EventListener);
    // Cross-tab updates via the storage event.
    const storageHandler = () => setFlags(readFeatureFlags());
    window.addEventListener('storage', storageHandler);
    return () => {
      window.removeEventListener('polyof:flags-changed', handler as EventListener);
      window.removeEventListener('storage', storageHandler);
    };
  }, []);
  return flags;
}
