'use client';

import { useState } from 'react';
import { ingestPassage } from '@/src/rag/ingest';
import { summarizeConflicts } from '@/src/rag/screen';
import { fail } from '@/src/webmcp/errors';
import { recordActivity, toCallToolResult } from '@/src/webmcp/registry';
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

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Capture both before the first await. `currentTarget` is nulled once the
    // event finishes dispatching, and `respondWith` may only be called while it
    // is still in flight.
    const form = event.currentTarget;
    const submit = event.nativeEvent as SubmitEvent;

    const data = new FormData(form);
    const text = String(data.get('text') ?? '');
    const sourceUrl = String(data.get('source_url') ?? '');
    const title = String(data.get('title') ?? '');

    const work = (async () => {
      if (text.trim().length < 50 || !sourceUrl.trim() || !title.trim()) {
        throw new Error('Text (50+ characters), source URL and title are all required.');
      }
      const result = await ingestPassage({ text, sourceUrl, title });
      return {
        ok: true as const,
        source_id: result.sourceId,
        staged_chunk_ids: result.stagedChunkIds,
        chunk_count: result.chunkCount,
        conflict_summary: summarizeConflicts(result.conflicts),
        requires_human_approval: true,
        message: `Staged ${result.chunkCount} chunk(s) for human review. They are NOT searchable yet.`,
      };
    })();

    /*
     * The half of the declarative API that is easy to miss, because the tool
     * shows up in getTools() without it and looks like it works.
     *
     * An agent's submission arrives here with `agentInvoked` set, and the only
     * channel back to that agent is `respondWith`. Without this branch the call
     * never resolves — measured: it hung until the bridge timed out at 120s and
     * staged nothing. `toolautosubmit` on the form is the other half; without
     * that attribute the runtime just focuses the submit button and waits for a
     * person who is not there.
     */
    if (submit.agentInvoked) {
      const name = form.getAttribute('toolname') ?? 'autorag_submit_passage_form';
      recordActivity(name, 'called', { source_url: sourceUrl, title });
      work.then(
        (result) => recordActivity(name, 'returned', result),
        (err: unknown) => recordActivity(name, 'failed', String(err)),
      );

      // D12 applies here too, and this is the path where it was missed a second
      // time: a bare object handed to `respondWith` reaches the agent as an empty
      // response, exactly as it did from `registerTool`. Same envelope, and
      // validation failures come back as a structured error rather than a
      // rejected promise the bridge would render as an opaque throw.
      submit.respondWith?.(
        work.then(toCallToolResult, (err: unknown) =>
          toCallToolResult(
            fail(
              'INVALID_INPUT',
              err instanceof Error ? err.message : String(err),
              undefined,
              'autorag_ingest_passage',
            ),
          ),
        ),
      );
    }

    setNote('Chunking and embedding…');
    work.then(
      (result) => {
        setNote(`Staged ${result.chunk_count} chunk(s) for review. ${result.conflict_summary}`);
        form.reset();
      },
      (err: unknown) => setNote(err instanceof Error ? err.message : String(err)),
    );
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
        toolautosubmit=""
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
