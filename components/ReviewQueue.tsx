'use client';

import { useCallback, useState, type ReactNode } from 'react';
import type { Chunk, Source } from '@/src/types';
import { chunksByStatus, allSources, decideChunks } from '@/src/rag/store';
import { useCorpusData } from '@/src/rag/hooks';
import ConflictBadge from './ConflictBadge';
import { Button, Empty, Field, Panel, Pill } from './ui';

/**
 * The human gate.
 *
 * `amendments.md` A1: this is **steering** — the person shapes what the memory
 * becomes. It is not a security control and must not be pitched as one.
 *
 * It is also the entire approval mechanism, because `requestUserInteraction` does
 * not exist in any shipping runtime (lib/webmcp/API-DELTA.md D4). The agent stages,
 * a person decides here, and the agent polls `autorag_list_pending`.
 */
export default function ReviewQueue({ sync }: { sync?: ReactNode }) {
  const load = useCallback(async (): Promise<{ pending: Chunk[]; sources: Source[] }> => {
    const [pending, sources] = await Promise.all([chunksByStatus('pending'), allSources()]);
    return { pending, sources };
  }, []);
  const [{ pending, sources }] = useCorpusData(load, { pending: [], sources: [] });
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const byId = new Map(sources.map((s) => [s.id, s]));

  const approve = (ids: string[]) => decideChunks(ids, 'approved');
  async function reject(id: string) {
    await decideChunks([id], 'rejected', reason.trim() || 'No reason given.');
    setRejecting(null);
    setReason('');
  }

  return (
    <Panel
      title="Waiting for you"
      right={
        /*
          Sync sits here as well as on the corpus below. Keeping a passage and
          getting it off this device are one action to the person doing them, so
          the control that finishes it is beside the buttons that start it — not a
          panel away. It is never conditional: a corpus that has never been pushed
          is exactly the one that needs pushing.
        */
        <span className="row">
          {pending.length > 0 ? (
            <>
              <Pill tone="warn">{pending.length} to review</Pill>
              <Button onClick={() => void approve(pending.map((c) => c.id))} tone="primary" small>
                Approve all
              </Button>
            </>
          ) : (
            <Pill tone="mute">all clear</Pill>
          )}
          {sync}
        </span>
      }
    >
      {pending.length === 0 ? (
        <Empty>
          Nothing staged. Keep a passage above, or let an agent call{' '}
          <code>autorag_ingest_passage</code>.
        </Empty>
      ) : (
        pending.map((chunk) => {
          const source = byId.get(chunk.sourceId);
          return (
            <article className="card" key={chunk.id}>
              <div className="card-head">
                <a className="card-title" href={source?.url} target="_blank" rel="noreferrer">
                  {source?.title ?? 'unknown source'}
                </a>
                <span className="meta">passage {chunk.ordinal + 1}</span>
              </div>

              <p className="card-text">
                {chunk.text.length > 460 ? `${chunk.text.slice(0, 460)}…` : chunk.text}
              </p>

              {chunk.conflicts.map((c, i) => (
                <ConflictBadge key={i} conflict={c} />
              ))}

              {rejecting === chunk.id ? (
                <div className="card-actions">
                  <Field
                    autoFocus
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why? (kept, and replayed if this comes back)"
                  />
                  <Button onClick={() => void reject(chunk.id)} tone="danger" small>
                    Confirm discard
                  </Button>
                  <Button onClick={() => setRejecting(null)} small>Cancel</Button>
                </div>
              ) : (
                <div className="card-actions">
                  <Button onClick={() => void approve([chunk.id])} tone="primary" small>
                    Keep
                  </Button>
                  <Button onClick={() => setRejecting(chunk.id)} tone="danger" small>
                    Discard
                  </Button>
                </div>
              )}
            </article>
          );
        })
      )}
    </Panel>
  );
}
