/**
 * The sidebar.
 *
 * Three things it must answer without being asked, because all three were
 * invisible before and the tool felt broken as a result:
 *
 *   1. Is the model ready, and if not, how far along?
 *   2. What is happening right now? Chunking, embedding and screening all run in
 *      an offscreen document nobody can see into.
 *   3. Is WebMCP actually live on this tab, or is that just a claim in a README?
 *
 * There is no source field anywhere here, and there never will be. The tab is the
 * source; asking a person to name it is asking them to retype what the browser
 * already knows.
 */

import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  PREVIEW_PAGE,
  PREVIEW_SELECTION,
  envelope,
  type Event,
  type Preview,
  type Request,
} from '../protocol';

async function ask<T>(request: Request): Promise<T | null> {
  const res = await chrome.runtime.sendMessage(envelope('worker', request));
  return res?.ok ? (res.data as T) : null;
}

const toActiveTab = <T,>(what: string): Promise<T | null> =>
  chrome.runtime.sendMessage({ type: 'autorag:to-active-tab', what });

interface Pending {
  chunk_id: string;
  text: string;
  conflicts: { kind: string; detail: string }[];
  source: { url: string; title: string };
}

interface Stats {
  approved: number;
  pending: number;
  rejected: number;
  chunk_count: number;
  source_count: number;
  model_ready: boolean;
  model_phase: string;
  model_progress: number | null;
  model_error: string | null;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/* ------------------------------------------------------------------ status */

function ModelStatus({ stats }: { stats: Stats | null }) {
  if (!stats) return <span className="chip">connecting…</span>;
  if (stats.model_error) {
    return <span className="chip bad" title={stats.model_error}>model failed</span>;
  }
  if (stats.model_ready) return <span className="chip ok">model ready</span>;
  const pct = stats.model_progress === null ? null : Math.round(stats.model_progress * 100);
  return <span className="chip warn">downloading model{pct === null ? '' : ` ${pct}%`}</span>;
}

/**
 * Answers "are we actually using WebMCP" by asking the page, every two seconds.
 * If this says four tools, an agent on this tab can call them right now.
 */
function WebmcpStatus() {
  const [state, setState] = useState<{ present: boolean; tools: string[] } | null>(null);

  useEffect(() => {
    const read = async () =>
      setState(await chrome.runtime.sendMessage({ type: 'autorag:webmcp-status' }));
    void read();
    const timer = setInterval(read, 2000);
    return () => clearInterval(timer);
  }, []);

  if (!state?.present) return <span className="chip">no WebMCP on this tab</span>;
  const mine = state.tools.filter((t) => t.startsWith('autorag_'));
  return (
    <span className="chip ok" title={state.tools.join('\n')}>
      {mine.length} tools live on this page
    </span>
  );
}

/* ----------------------------------------------------------------- capture */

/**
 * Whole-page capture, but you see it first.
 *
 * "Keep this page" on a long article is thousands of words, and handing that to a
 * memory sight-unseen is how a corpus fills with navigation chrome. The preview is
 * editable: trim it to the part that mattered before it goes in.
 */
function CurrentTab({ onCaptured }: { onCaptured: () => void }) {
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const read = async () => {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      setTab(t ?? null);
    };
    void read();
    chrome.tabs.onActivated.addListener(read);
    chrome.tabs.onUpdated.addListener(read);
    return () => {
      chrome.tabs.onActivated.removeListener(read);
      chrome.tabs.onUpdated.removeListener(read);
    };
  }, []);

  async function show(what: string) {
    setNote(null);
    const p = await toActiveTab<Preview>(what);
    if (!p) return setNote('Cannot read this tab. Browser pages and PDFs are off limits.');
    if (p.text.trim().length < 50) {
      return setNote(
        what === PREVIEW_SELECTION
          ? 'Nothing is highlighted on this page.'
          : 'No readable text found on this page.',
      );
    }
    setPreview(p);
    setDraft(p.text);
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    const res = await ask({
      kind: 'ingest',
      text: draft.trim(),
      sourceUrl: preview.url,
      title: preview.title,
    });
    setBusy(false);
    setPreview(null);
    setNote(res ? null : 'Capture failed.');
    onCaptured();
  }

  return (
    <section>
      <h2>Reading now</h2>
      <div className="card">
        <span className="src" title={tab?.url}>
          {tab?.title || tab?.url || 'no active tab'}
        </span>

        {preview ? (
          <>
            <p className="note">
              {words(draft)} words · {draft.length} characters. Trim it before keeping if you
              only want part.
            </p>
            <textarea
              className="preview"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="row">
              <button className="primary" onClick={commit} disabled={busy || draft.trim().length < 50}>
                {busy ? 'Keeping…' : `Keep ${words(draft)} words`}
              </button>
              <button onClick={() => setPreview(null)} disabled={busy}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="row">
              <button className="primary" onClick={() => show(PREVIEW_PAGE)}>
                Preview this page
              </button>
              <button onClick={() => show(PREVIEW_SELECTION)}>Preview selection</button>
            </div>
            <p className="note" style={{ margin: '8px 0 0' }}>
              Or highlight text on the page and click <strong>Keep</strong> — that one is
              instant, no preview. <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> does the same
              from the keyboard.
            </p>
          </>
        )}

        {note && <p className="note warn">{note}</p>}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- activity */

function Activity() {
  const [events, setEvents] = useState<Event[]>([]);

  useEffect(() => {
    const read = async () => setEvents((await ask<Event[]>({ kind: 'activity' })) ?? []);
    void read();
    const timer = setInterval(read, 1000);
    return () => clearInterval(timer);
  }, []);

  if (events.length === 0) return null;
  return (
    <section>
      <h2>Activity</h2>
      <div className="card feed">
        {events.slice(0, 8).map((e, i) => (
          <div key={i} className="event">
            <span className={`dot ${e.phase}`} />
            <span className="when">
              {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
            <span>{e.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ review */

function ReviewCard({ item, onDone }: { item: Pending; onDone: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <div className="card">
      <a className="src" href={item.source.url} target="_blank" rel="noreferrer">
        {item.source.title || item.source.url}
      </a>
      <p className="text">{item.text}</p>
      <p className="note">{words(item.text)} words</p>

      {item.conflicts.map((c, i) => (
        <div key={i} className="conflict">
          <span className="badge">{c.kind.replace('_', ' ')}</span>
          <span>{c.detail}</span>
        </div>
      ))}

      {rejecting ? (
        <div className="row">
          <input
            autoFocus
            placeholder="Why not? (replayed if this comes back)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            className="danger"
            disabled={!reason.trim()}
            onClick={async () => {
              await ask({ kind: 'reject', chunkIds: [item.chunk_id], reason: reason.trim() });
              onDone();
            }}
          >
            Discard
          </button>
        </div>
      ) : (
        <div className="row">
          <button
            className="primary"
            onClick={async () => {
              await ask({ kind: 'approve', chunkIds: [item.chunk_id] });
              onDone();
            }}
          >
            Keep
          </button>
          <button onClick={() => setRejecting(true)}>Discard…</button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ recall */

function Recall() {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<{
    hits: { text: string; source: { url: string; title: string } }[];
    confidence: string;
    coverage_note: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!q.trim()) return;
    setBusy(true);
    setResult(await ask({ kind: 'answer', question: q.trim() }));
    setBusy(false);
  }

  return (
    <section>
      <h2>Recall</h2>
      <div className="row">
        <input
          placeholder="Ask what you've kept…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <button onClick={run} disabled={busy}>
          {busy ? '…' : 'Ask'}
        </button>
      </div>
      {result && (
        <>
          <p className="note">
            <span className={`badge conf-${result.confidence}`}>{result.confidence}</span>{' '}
            {result.coverage_note}
          </p>
          {result.hits.map((h, i) => (
            <div key={i} className="card">
              <a className="src" href={h.source.url} target="_blank" rel="noreferrer">
                {h.source.title || h.source.url}
              </a>
              <p className="text">{h.text}</p>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

/* --------------------------------------------------------------------- app */

function App() {
  const [pending, setPending] = useState<Pending[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);

  const refresh = useCallback(async () => {
    const [p, s] = await Promise.all([
      ask<Pending[]>({ kind: 'listPending' }),
      ask<Stats>({ kind: 'stats' }),
    ]);
    if (p) setPending(p);
    if (s) setStats(s);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="app">
      <header>
        <h1>Autorag</h1>
        <div className="chips">
          <ModelStatus stats={stats} />
          <WebmcpStatus />
        </div>
      </header>

      <p className="note">
        {stats
          ? `${stats.approved} kept · ${stats.pending} to review · ${stats.rejected} discarded · ${stats.source_count} sources`
          : 'reading corpus…'}
        <br />
        Stored in this extension, on this machine. Nothing is uploaded.
      </p>

      <CurrentTab onCaptured={refresh} />

      <section>
        <h2>To review {pending.length > 0 && <span className="pill">{pending.length}</span>}</h2>
        {pending.length === 0 ? (
          <p className="empty">
            Nothing waiting. Highlight something on any page, or preview this one above.
          </p>
        ) : (
          pending.map((item) => <ReviewCard key={item.chunk_id} item={item} onDone={refresh} />)
        )}
      </section>

      <Recall />
      <Activity />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
