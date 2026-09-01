'use client';

import { useState } from 'react';
import { ingestPassage } from '@/src/rag/ingest';
import { summarizeConflicts } from '@/src/rag/screen';
import { Button, Panel } from './ui';

/**
 * Manual paste path. The agent normally does this via `autorag_ingest_passage`;
 * this exists so a human can seed the corpus and so the Phase 1 gate
 * (paste → search → correct chunk) is testable without an agent.
 */
export default function IngestForm() {
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function submit() {
    if (!text.trim() || !url.trim() || !title.trim()) {
      setNote('Text, source URL, and title are all required.');
      return;
    }
    setBusy(true);
    setNote('Chunking and embedding…');
    try {
      const result = await ingestPassage({ text, sourceUrl: url, title });
      setNote(
        `Staged ${result.chunkCount} chunk${result.chunkCount === 1 ? '' : 's'} for review. ` +
          summarizeConflicts(result.conflicts),
      );
      setText('');
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const input: React.CSSProperties = {
    width: '100%',
    background: 'var(--bg)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '7px 9px',
    font: 'inherit',
    fontSize: 13,
  };

  return (
    <Panel title="Ingest a passage">
      <div style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <input
            style={input}
            placeholder="Source URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <input
            style={input}
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <textarea
          style={{ ...input, minHeight: 110, resize: 'vertical' }}
          placeholder="Paste the passage worth remembering…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Button onClick={submit} tone="primary" disabled={busy}>
            {busy ? 'Working…' : 'Stage for review'}
          </Button>
          {note && <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>{note}</span>}
        </div>
      </div>
    </Panel>
  );
}
