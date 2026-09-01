'use client';

import { useCallback, useState } from 'react';
import type { Chunk, Source } from '@/src/types';
import { chunksByStatus, allSources, decideChunks } from '@/src/rag/store';
import { useCorpusData } from '@/src/rag/hooks';
import ConflictBadge from './ConflictBadge';
import { Button, Empty, Panel, Pill } from './ui';

/**
 * The human gate, and the star of the video.
 *
 * `amendments.md` A1: this is **steering** — the human shapes what the memory
 * becomes. It is not a security control and must not be pitched as one.
 *
 * It is also the entire approval mechanism, because `requestUserInteraction`
 * does not exist in any shipping runtime (lib/webmcp/API-DELTA.md D4). The agent
 * stages; a person decides here; the agent polls `autorag_list_pending`.
 */
export default function ReviewQueue() {
  const load = useCallback(async (): Promise<{ pending: Chunk[]; sources: Source[] }> => {
    const [pending, sources] = await Promise.all([chunksByStatus('pending'), allSources()]);
    return { pending, sources };
  }, []);
  const [{ pending, sources }] = useCorpusData(load, { pending: [], sources: [] });
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const byId = new Map(sources.map((s) => [s.id, s]));

  async function approve(ids: string[]) {
    await decideChunks(ids, 'approved');
  }
  async function reject(id: string) {
    await decideChunks([id], 'rejected', reason.trim() || 'No reason given.');
    setRejecting(null);
    setReason('');
  }

  return (
    <Panel
      title="Review queue"
      right={
        pending.length > 0 ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Pill tone="warn">{pending.length} awaiting you</Pill>
            <Button onClick={() => approve(pending.map((c) => c.id))} tone="primary">
              Approve all
            </Button>
          </div>
        ) : (
          <Pill tone="mute">empty</Pill>
        )
      }
    >
      {pending.length === 0 ? (
        <Empty>
          Nothing staged. Ingest a passage above, or let an agent call{' '}
          <code>autorag_ingest_passage</code>.
        </Empty>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {pending.map((chunk) => {
            const source = byId.get(chunk.sourceId);
            return (
              <article
                key={chunk.id}
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
                  }}
                >
                  <a
                    href={source?.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 12.5, fontWeight: 600 }}
                  >
                    {source?.title ?? 'unknown source'}
                  </a>
                  <span style={{ color: 'var(--muted)', fontSize: 11.5, whiteSpace: 'nowrap' }}>
                    chunk {chunk.ordinal + 1}
                  </span>
                </div>

                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
                  {chunk.text.length > 420 ? chunk.text.slice(0, 420) + '…' : chunk.text}
                </p>

                {chunk.conflicts.map((c, i) => (
                  <ConflictBadge key={i} conflict={c} />
                ))}

                {rejecting === chunk.id ? (
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <input
                      autoFocus
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Why is this being rejected? (kept, and shown on future conflicts)"
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
                    <Button onClick={() => reject(chunk.id)} tone="danger">
                      Confirm reject
                    </Button>
                    <Button onClick={() => setRejecting(null)}>Cancel</Button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <Button onClick={() => approve([chunk.id])} tone="primary">
                      Approve
                    </Button>
                    <Button onClick={() => setRejecting(chunk.id)} tone="danger">
                      Reject
                    </Button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
