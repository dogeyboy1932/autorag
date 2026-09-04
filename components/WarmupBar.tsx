'use client';

import { useEffect } from 'react';
import { warmup } from '@/src/rag/embed';
import { useWarmup } from '@/src/rag/hooks';
import { Pill } from './ui';

/**
 * Cold start is risk A5.1 — a ~25MB model download where silence reads as
 * breakage. Warm on mount and always say what is happening.
 */
export default function WarmupBar() {
  const state = useWarmup();

  useEffect(() => {
    warmup().catch(() => {
      /* surfaced through warmup state */
    });
  }, []);

  const pct = state.progress === null ? null : Math.round(state.progress * 100);

  return (
    <span className="row">
      {state.phase === 'ready' && <Pill tone="ok">model ready · {state.backend}</Pill>}
      {state.phase === 'loading' && (
        <Pill tone="warn">
          downloading embedding model{pct === null ? '…' : ` · ${pct}%`}
        </Pill>
      )}
      {state.phase === 'failed' && <Pill tone="bad">embeddings unavailable</Pill>}
      {state.phase === 'idle' && <Pill tone="mute">starting…</Pill>}
    </span>
  );
}
