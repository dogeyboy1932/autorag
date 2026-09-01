'use client';

import { useCallback, useState } from 'react';
import type { Chunk, Source } from '@/src/types';
import { allChunks, allSources, deleteSourceCascade, setSourceStale } from '@/src/rag/store';
import { useCorpusData } from '@/src/rag/hooks';
import { Button, Empty, Panel, Pill } from './ui';

/**
 * The corpus, by source. Mirrors `autorag_list_sources`, `autorag_mark_stale`
 * and `autorag_forget_source` so a human can do anything an agent can.
 *
 * Forgetting is the only irreversible action in the app and there is no
 * browser-mediated confirmation to lean on (API-DELTA D4), so it asks twice
 * here, exactly as the tool requires `confirm: true`.
 */
export default function CorpusView() {
  const load = useCallback(async (): Promise<{ sources: Source[]; chunks: Chunk[] }> => {
    const [sources, chunks] = await Promise.all([allSources(), allChunks()]);
    return { sources, chunks };
  }, []);
  const [{ sources, chunks }] = useCorpusData(load, { sources: [], chunks: [] });

  const [confirming, setConfirming] = useState<string | null>(null);
  const [staling, setStaling] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const counts = new Map<string, { approved: number; pending: number }>();
  for (const c of chunks) {
    const e = counts.get(c.sourceId) ?? { approved: 0, pending: 0 };
    if (c.status === 'approved') e.approved++;
    if (c.status === 'pending') e.pending++;
    counts.set(c.sourceId, e);
  }

  async function markStale(id: string) {
    await setSourceStale(id, true, reason.trim() || 'Marked outdated by the curator.');
    setStaling(null);
    setReason('');
  }

  return (
    <Panel title="Corpus" right={<Pill tone="mute">{sources.length} sources</Pill>}>
      {sources.length === 0 ? (
        <Empty>Nothing ingested yet.</Empty>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {sources.map((s) => {
            const c = counts.get(s.id) ?? { approved: 0, pending: 0 };
            return (
              <div
                key={s.id}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 10,
                  background: 'var(--bg)',
                  opacity: s.stale ? 0.72 : 1,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 10,
                    flexWrap: 'wrap',
                    alignItems: 'baseline',
                  }}
                >
                  <a href={s.url} target="_blank" rel="noreferrer" style={{ fontSize: 12.5 }}>
                    {s.title}
                  </a>
                  <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                    {c.approved} approved{c.pending > 0 && ` · ${c.pending} pending`} · ingested{' '}
                    {new Date(s.ingestedAt).toLocaleDateString()}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  {s.stale && <Pill tone="warn">stale · demoted in ranking</Pill>}
                  {s.tags.map((t) => (
                    <Pill key={t} tone="mute">
                      {t}
                    </Pill>
                  ))}
                </div>
                {s.stale && s.staleReason && (
                  <p style={{ color: 'var(--muted)', fontSize: 12, margin: '6px 0 0' }}>
                    {s.staleReason}
                  </p>
                )}

                {staling === s.id ? (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <input
                      autoFocus
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Why is this outdated?"
                      style={{
                        flex: 1,
                        background: 'var(--panel)',
                        color: 'var(--fg)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        padding: '5px 8px',
                        font: 'inherit',
                        fontSize: 12.5,
                      }}
                    />
                    <Button onClick={() => markStale(s.id)} tone="primary">
                      Mark stale
                    </Button>
                    <Button onClick={() => setStaling(null)}>Cancel</Button>
                  </div>
                ) : confirming === s.id ? (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                    <span style={{ color: 'var(--bad)', fontSize: 12 }}>
                      Delete this source and {c.approved + c.pending} passage(s) permanently?
                    </span>
                    <Button
                      onClick={async () => {
                        await deleteSourceCascade(s.id);
                        setConfirming(null);
                      }}
                      tone="danger"
                    >
                      Yes, forget it
                    </Button>
                    <Button onClick={() => setConfirming(null)}>Cancel</Button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    {s.stale ? (
                      <Button onClick={() => setSourceStale(s.id, false)}>Clear stale flag</Button>
                    ) : (
                      <Button onClick={() => setStaling(s.id)}>Mark stale</Button>
                    )}
                    <Button onClick={() => setConfirming(s.id)} tone="danger">
                      Forget
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
