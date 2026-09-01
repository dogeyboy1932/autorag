/**
 * The sidebar. Review queue and recall, beside whatever you are reading.
 *
 * Deliberately not the dashboard from the web app. There is no "paste a source
 * URL" field, because by the time anything reaches this panel the URL, the title
 * and the text were captured from the page you were on. The only thing left for
 * a person to do is the one thing only a person can: decide what is worth
 * keeping.
 */

import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { envelope, type Request } from '../protocol';

async function ask<T>(request: Request): Promise<T | null> {
  const res = await chrome.runtime.sendMessage(envelope('worker', request));
  return res?.ok ? (res.data as T) : null;
}

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
  source_count: number;
  model_ready: boolean;
}

function useCorpus() {
  const [pending, setPending] = useState<Pending[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);

  const refresh = useCallback(async () => {
    const [p, s] = await Promise.all([ask<Pending[]>({ kind: 'listPending' }), ask<Stats>({ kind: 'stats' })]);
    if (p) setPending(p);
    if (s) setStats(s);
  }, []);

  useEffect(() => {
    void refresh();
    // No corpus-change event crosses contexts, so the panel polls. Cheap: both
    // calls are IndexedDB reads against a corpus measured in hundreds of rows.
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [refresh]);

  return { pending, stats, refresh };
}

function ReviewCard({ item, onDone }: { item: Pending; onDone: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <div className="card">
      <a className="src" href={item.source.url} target="_blank" rel="noreferrer">
        {item.source.title || item.source.url}
      </a>
      <p className="text">{item.text}</p>

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
            placeholder="Why not? (kept, and replayed if this comes back)"
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
            Reject
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

function Recall() {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<{
    hits: { text: string; source: { url: string; title: string }; score: number }[];
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

function App() {
  const { pending, stats, refresh } = useCorpus();

  return (
    <div className="app">
      <header>
        <h1>Autorag</h1>
        <span className="counts">
          {stats ? `${stats.approved} kept · ${stats.pending} to review` : 'loading…'}
        </span>
      </header>

      {stats && !stats.model_ready && (
        <p className="note warn">
          Loading the embedding model (~25MB, once). Captures will queue until it is ready.
        </p>
      )}

      <section>
        <h2>To review {pending.length > 0 && <span className="pill">{pending.length}</span>}</h2>
        {pending.length === 0 ? (
          <p className="empty">
            Nothing waiting. Highlight text on any page and press <strong>Keep</strong>.
          </p>
        ) : (
          pending.map((item) => <ReviewCard key={item.chunk_id} item={item} onDone={refresh} />)
        )}
      </section>

      <Recall />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
