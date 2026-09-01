'use client';

import { useState } from 'react';
import { search, confidenceOf, coverageNote, type SearchResult } from '@/src/rag/search';
import { Button, Empty, Panel, Pill } from './ui';

/**
 * Retrieval with provenance. Provenance is the half that pasting a document into
 * context cannot give you (`amendments.md` A6), so every hit shows its source and
 * when it entered the corpus.
 */
export default function SearchPanel() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [asked, setAsked] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!query.trim()) return;
    setBusy(true);
    try {
      setResult(await search(query, { k: 5 }));
      setAsked(query.trim());
    } finally {
      setBusy(false);
    }
  }

  const confidence = result ? confidenceOf(result.hits, asked, result.docs) : null;

  return (
    <Panel
      title="Search the memory"
      right={
        confidence && (
          <Pill tone={confidence === 'high' ? 'ok' : confidence === 'medium' ? 'warn' : 'bad'}>
            confidence {confidence}
          </Pill>
        )
      }
    >
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          placeholder="Ask the corpus something…"
          style={{
            flex: 1,
            background: 'var(--bg)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '7px 9px',
            font: 'inherit',
            fontSize: 13,
          }}
        />
        <Button onClick={run} tone="primary" disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </Button>
      </div>

      {result && (
        <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>
            {coverageNote(result.hits, result.totalCandidates, confidence ?? 'medium', result.unmatchedTerms, asked)}
          </span>
          {result.hits.length === 0 ? (
            <Empty>No approved chunks matched. Approve something in the review queue first.</Empty>
          ) : (
            result.hits.map((hit) => (
              <article
                key={hit.chunk.id}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 11,
                  background: 'var(--bg)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    marginBottom: 6,
                    flexWrap: 'wrap',
                  }}
                >
                  <a href={hit.source.url} target="_blank" rel="noreferrer" style={{ fontSize: 12.5 }}>
                    {hit.source.title}
                  </a>
                  <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                    score {hit.score.toFixed(3)}
                    {hit.source.stale && ' · demoted (stale)'} · ingested{' '}
                    {new Date(hit.source.ingestedAt).toLocaleDateString()}
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>{hit.chunk.text}</p>
              </article>
            ))
          )}
        </div>
      )}
    </Panel>
  );
}
