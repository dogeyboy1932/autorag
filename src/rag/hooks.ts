'use client';

import { useCallback, useEffect, useState } from 'react';
import { onCorpusChange } from './bus';
import { onWarmup, type WarmupState } from './embed';

/** Re-runs `load` on mount and on every corpus mutation, from UI or agent alike. */
export function useCorpusData<T>(load: () => Promise<T>, initial: T): [T, () => void] {
  const [data, setData] = useState<T>(initial);

  const refresh = useCallback(() => {
    let stale = false;
    load().then((next) => {
      if (!stale) setData(next);
    });
    return () => {
      stale = true;
    };
  }, [load]);

  useEffect(() => {
    refresh();
    return onCorpusChange(refresh);
  }, [refresh]);

  return [data, refresh];
}

export function useWarmup(): WarmupState {
  const [state, setState] = useState<WarmupState>({
    phase: 'idle',
    progress: null,
    backend: null,
  });
  useEffect(() => onWarmup(setState), []);
  return state;
}
