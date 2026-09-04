'use client';

import { useCallback } from 'react';
import { allSources, countByStatus } from '@/src/rag/store';
import { useCorpusData } from '@/src/rag/hooks';

/**
 * The counts, in the footer.
 *
 * They were a four-column strip under the header, which gave "rejected" the same
 * visual weight as "kept" and pushed the thing you came to do below the fold. They
 * are a glance, not a dashboard — and in the footer they are on every tab, so
 * approving something in Library and then asking about it in Ask never means
 * navigating back to check that it landed.
 */
export default function StatsBar() {
  const load = useCallback(async () => {
    const [counts, sources] = await Promise.all([countByStatus(), allSources()]);
    return { counts, sourceCount: sources.length };
  }, []);
  const [{ counts, sourceCount }] = useCorpusData(load, {
    counts: { pending: 0, approved: 0, rejected: 0 },
    sourceCount: 0,
  });

  const items: [string, number][] = [
    ['kept', counts.approved],
    ['to review', counts.pending],
    ['sources', sourceCount],
  ];

  return (
    <span className="stats">
      {items.map(([label, n]) => (
        <span className="stat" key={label}>
          <strong className="stat-value">{n}</strong>
          <span className="stat-label">{label}</span>
        </span>
      ))}
    </span>
  );
}
