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
    <div className="stats-strip">
      {items.map(([label, n]) => (
        <span key={label} className="stat-item">
          <strong className="stat-value">{n}</strong>
          <span className="stat-label">{label}</span>
        </span>
      ))}
    </div>
  );
}
