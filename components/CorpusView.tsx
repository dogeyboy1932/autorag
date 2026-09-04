'use client';

import { useCallback, useState, type ReactNode } from 'react';
import type { Chunk, Source } from '@/src/types';
import { allChunks, allSources, deleteSourceCascade, setSourceStale } from '@/src/rag/store';
import { useCorpusData } from '@/src/rag/hooks';
import { Button, Empty, Field, Panel, Pill } from './ui';

/**
 * The corpus, by source. Mirrors `autorag_list_sources`, `autorag_mark_stale` and
 * `autorag_forget_source`, so a human can do anything an agent can.
 *
 * Forgetting is the only irreversible action in the app and there is no
 * browser-mediated confirmation to lean on (API-DELTA D4), so it asks twice here —
 * exactly as the tool requires `confirm: true`.
 */
export default function CorpusView({ sync }: { sync?: ReactNode }) {
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
    <Panel
      title="What you have kept"
      right={
        <span className="row">
          {sync}
          <Pill tone="mute">{sources.length} sources</Pill>
        </span>
      }
    >
      {sources.length === 0 ? (
        <Empty>Nothing kept yet.</Empty>
      ) : (
        sources.map((s) => {
          const c = counts.get(s.id) ?? { approved: 0, pending: 0 };
          return (
            <div className="card" key={s.id} style={{ opacity: s.stale ? 0.72 : 1 }}>
              <div className="card-head">
                <a className="card-title" href={s.url} target="_blank" rel="noreferrer">
                  {s.title}
                </a>
                <span className="meta">
                  {c.approved} kept{c.pending > 0 && ` · ${c.pending} to review`} ·{' '}
                  {new Date(s.ingestedAt).toLocaleDateString()}
                </span>
              </div>

              {(s.stale || s.tags.length > 0) && (
                <div className="row" style={{ marginBottom: 8 }}>
                  {s.stale && <Pill tone="warn">stale · demoted in ranking</Pill>}
                  {s.tags.map((t) => (
                    <Pill key={t} tone="mute">{t}</Pill>
                  ))}
                </div>
              )}
              {s.stale && s.staleReason && <p className="note">{s.staleReason}</p>}

              {staling === s.id ? (
                <div className="card-actions">
                  <Field
                    autoFocus
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why is this outdated?"
                  />
                  <Button onClick={() => void markStale(s.id)} tone="primary" small>Mark stale</Button>
                  <Button onClick={() => setStaling(null)} small>Cancel</Button>
                </div>
              ) : confirming === s.id ? (
                <div className="card-actions">
                  <span className="note bad">
                    Delete this source and {c.approved + c.pending} passage(s) permanently?
                  </span>
                  <Button
                    tone="danger"
                    small
                    onClick={async () => {
                      await deleteSourceCascade(s.id);
                      setConfirming(null);
                    }}
                  >
                    Yes, forget it
                  </Button>
                  <Button onClick={() => setConfirming(null)} small>Cancel</Button>
                </div>
              ) : (
                <div className="card-actions">
                  {s.stale ? (
                    <Button onClick={() => void setSourceStale(s.id, false)} small>Clear stale flag</Button>
                  ) : (
                    <Button onClick={() => setStaling(s.id)} small>Mark stale</Button>
                  )}
                  <Button onClick={() => setConfirming(s.id)} tone="danger" small>Forget</Button>
                </div>
              )}
            </div>
          );
        })
      )}
    </Panel>
  );
}
