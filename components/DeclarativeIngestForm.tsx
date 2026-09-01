'use client';

import { useState } from 'react';
import { ingestPassage } from '@/src/rag/ingest';
import { summarizeConflicts } from '@/src/rag/screen';
import { Panel, Pill } from './ui';

/**
 * The declarative WebMCP API: a plain HTML <form> annotated so the browser
 * derives a tool from it automatically. No JavaScript registration involved —
 * this is the second of the two registration APIs, in the same repo as the
 * imperative surface in src/webmcp/tools/.
 *
 * The attributes below are not decoration. Chrome 151 ships DevTools issues that
 * validate exactly five things (extracted from the binary, see API-DELTA D10):
 *
 *   FormModelContextMissingToolName                      -> toolname
 *   FormModelContextMissingToolDescription               -> tooldescription
 *   FormModelContextParameterMissingName                 -> name on every field
 *   FormModelContextParameterMissingTitleAndDescription  -> title AND
 *                                                           toolparamdescription
 *   FormModelContextRequiredParameterMissingName         -> name on required fields
 *
 * Every field therefore carries name + title + toolparamdescription. Check the
 * DevTools Issues panel for those strings if this ever stops being picked up.
 */
export default function DeclarativeIngestForm() {
  const [note, setNote] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = String(data.get('text') ?? '');
    const sourceUrl = String(data.get('source_url') ?? '');
    const title = String(data.get('title') ?? '');

    if (text.trim().length < 50 || !sourceUrl.trim() || !title.trim()) {
      setNote('Text (50+ characters), source URL and title are all required.');
      return;
    }

    setNote('Chunking and embedding…');
    try {
      const result = await ingestPassage({ text, sourceUrl, title });
      setNote(
        `Staged ${result.chunkCount} chunk(s) for review. ${summarizeConflicts(result.conflicts)}`,
      );
      event.currentTarget.reset();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  }

  const field: React.CSSProperties = {
    width: '100%',
    background: 'var(--bg)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '7px 9px',
    font: 'inherit',
    fontSize: 13,
  };
  const label: React.CSSProperties = { fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 3 };

  return (
    <Panel title="Declarative API" right={<Pill tone="mute">form-derived tool</Pill>}>
      <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: '0 0 10px' }}>
        The same ingest capability exposed the other way: an annotated HTML form the
        browser turns into a tool on its own, with no registration code.
      </p>
      <form
        onSubmit={onSubmit}
        toolname="autorag_submit_passage_form"
        tooldescription="Submit a passage to Autorag's review queue using the page's own form. Equivalent to autorag_ingest_passage: the passage is chunked, embedded and staged for human approval, and does not become searchable until a person approves it."
        style={{ display: 'grid', gap: 9 }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
          <div>
            <label htmlFor="df-url" style={label}>
              Source URL
            </label>
            <input
              id="df-url"
              name="source_url"
              type="url"
              required
              title="Source URL"
              toolparamdescription="Canonical URL the passage came from, used for provenance and deduplication. Prefer a permalink over a search or redirect URL."
              placeholder="https://…"
              style={field}
            />
          </div>
          <div>
            <label htmlFor="df-title" style={label}>
              Title
            </label>
            <input
              id="df-title"
              name="title"
              type="text"
              required
              title="Source title"
              toolparamdescription="Human-readable title of the source, shown to the person reviewing this passage."
              placeholder="Page title"
              style={field}
            />
          </div>
        </div>
        <div>
          <label htmlFor="df-text" style={label}>
            Passage
          </label>
          <textarea
            id="df-text"
            name="text"
            required
            title="Passage text"
            toolparamdescription="The passage to remember, as plain text, at least 50 characters. Send the meaningful body only, with navigation and cookie banners stripped."
            placeholder="Paste the passage…"
            style={{ ...field, minHeight: 80, resize: 'vertical' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button
            type="submit"
            style={{
              background: 'rgba(68,147,248,.15)',
              color: 'var(--accent)',
              border: '1px solid rgba(68,147,248,.4)',
              borderRadius: 6,
              padding: '5px 11px',
              font: 'inherit',
              fontSize: 12.5,
              cursor: 'pointer',
            }}
          >
            Submit via form
          </button>
          {note && <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>{note}</span>}
        </div>
      </form>
    </Panel>
  );
}
