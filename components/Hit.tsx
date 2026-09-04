'use client';

import { useState } from 'react';
import type { SearchHit } from '@/src/types';
import { revisePassage } from '@/src/rag/ingest';
import { decideChunks } from '@/src/rag/store';
import { Button, Field, TextArea } from './ui';

/**
 * One retrieved passage, editable where you found it.
 *
 * ## Why the actions are here and not only in the review queue
 *
 * This is where you *notice*. A passage that swallowed a cookie banner or clipped
 * a sentence looks fine sitting in the queue and looks wrong the moment it comes
 * back as evidence for an answer — and at that moment the only previous route was
 * to forget the whole page and keep it again, throwing away every other passage
 * from it.
 *
 * Editing an approved passage sends it back to the queue, because approval means a
 * person vouched for what it said and changing the text withdraws that. The note
 * below says so before you start typing rather than after you save.
 *
 * The number matches the `[1]`, `[2]` markers in the answer above it. That is the
 * whole promise of a cited answer: the bracket is a place you can actually go.
 */
export default function Hit({
  n,
  hit,
  onEdited,
}: {
  n: number;
  hit: SearchHit;
  /** `gone` is true when the passage left the corpus, so the caller can drop it. */
  onEdited: (gone: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [draft, setDraft] = useState(hit.chunk.text);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await revisePassage(hit.chunk.id, { text: draft });
      setEditing(false);
      // An edit returns the passage to the review queue, so it leaves the corpus
      // too — until it is approved again.
      onEdited(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    setBusy(true);
    setErr(null);
    try {
      await decideChunks([hit.chunk.id], 'rejected', reason.trim() || undefined);
      setDiscarding(false);
      onEdited(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card">
      <div className="card-head">
        <a className="card-title" href={hit.source.url} target="_blank" rel="noreferrer">
          [{n}] {hit.source.title || hit.source.url}
        </a>
        <span className="meta">
          {hit.score.toFixed(2)}
          {hit.source.stale && ' · stale'} · {new Date(hit.source.ingestedAt).toLocaleDateString()}
        </span>
      </div>

      {editing ? (
        <div className="stack">
          <p className="note">
            Editing this sends it back to the review queue — approval means you vouched for
            what it said, and changing the words withdraws that.
          </p>
          <TextArea rows={7} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="row">
            <Button tone="primary" small disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button small disabled={busy} onClick={() => { setEditing(false); setDraft(hit.chunk.text); }}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="card-text">{hit.chunk.text}</p>
      )}

      {hit.chunk.note && !editing && (
        <p className="note" style={{ marginTop: 8 }}>
          <strong>Your note:</strong> {hit.chunk.note}
        </p>
      )}

      {discarding ? (
        <div className="row" style={{ marginTop: 12 }}>
          <Field
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why? (kept, and replayed if this comes back)"
          />
          <Button tone="danger" small disabled={busy} onClick={() => void discard()}>
            {busy ? '…' : 'Discard'}
          </Button>
          <Button small disabled={busy} onClick={() => setDiscarding(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        !editing && (
          <div className="card-actions">
            <Button small onClick={() => setEditing(true)}>Edit</Button>
            <Button small tone="danger" onClick={() => setDiscarding(true)}>Discard</Button>
          </div>
        )
      )}

      {err && <p className="note bad" style={{ marginTop: 8 }}>{err}</p>}
    </article>
  );
}
