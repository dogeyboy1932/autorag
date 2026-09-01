'use client';

import { useCallback } from 'react';
import { allSources, countByStatus } from '@/src/rag/store';
import { useCorpusData } from '@/src/rag/hooks';

export default function StatsBar() {
  const load = useCallback(async () => {
    const [counts, sources] = await Promise.all([countByStatus(), allSources()]);
    return { counts, sourceCount: sources.length };
  }, []);
  const [{ counts, sourceCount }] = useCorpusData(load, {
    counts: { pending: 0, approved: 0, rejected: 0 },
    sourceCount: 0,
  });

  const items = [
    ['approved', counts.approved],
    ['pending', counts.pending],
    ['rejected', counts.rejected],
    ['sources', sourceCount],
  ] as const;

  return (
    <div style={{ display: 'flex', gap: 18, fontSize: 12.5 }}>
      {items.map(([label, n]) => (
        <span key={label} style={{ color: 'var(--muted)' }}>
          <strong style={{ color: 'var(--fg)' }}>{n}</strong> {label}
        </span>
      ))}
    </div>
  );
}
