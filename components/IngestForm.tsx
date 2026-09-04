'use client';

import { useState } from 'react';
import { ingestPassage } from '@/src/rag/ingest';
import { summarizeConflicts } from '@/src/rag/screen';
import { Button, Field, Panel, TextArea } from './ui';

/**
 * The manual capture path.
 *
 * The extension gets this from the page you are reading; here you paste it. An
 * agent normally does it through `autorag_ingest_passage`, and this exists so a
 * human can seed a corpus without one — and so the whole loop (paste → screen →
 * review → search) is testable with nothing else installed.
 */
export default function IngestForm() {
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function submit() {
    if (!text.trim() || !url.trim() || !title.trim()) {
      setNote('Text, source URL and title are all required — provenance is the point.');
      return;
    }
    setBusy(true);
    setNote('Chunking and embedding…');
    try {
      const result = await ingestPassage({ text, sourceUrl: url, title });
      setNote(
        `Staged ${result.chunkCount} passage${result.chunkCount === 1 ? '' : 's'} for review. ` +
          summarizeConflicts(result.conflicts),
      );
      setText('');
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Keep a passage">
      <div className="row">
        <Field placeholder="Source URL" value={url} onChange={(e) => setUrl(e.target.value)} />
        <Field placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <TextArea
        rows={5}
        placeholder="Paste the passage worth remembering…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row">
        <Button onClick={() => void submit()} tone="primary" disabled={busy}>
          {busy ? 'Working…' : 'Stage for review'}
        </Button>
        {note && <span className="note">{note}</span>}
      </div>
    </Panel>
  );
}
