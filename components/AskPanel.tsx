'use client';

import { useEffect, useRef, useState } from 'react';
import type { SearchHit } from '@/src/types';
import { search, confidenceOf, coverageNote } from '@/src/rag/search';
import { askModel, standaloneQuery, type DemoUsage, type Passage } from '@/src/rag/answer';
import type { AskSettings, AskTurn } from '@/src/rag/ask';
import Hit from './Hit';
import { Button, Empty, Field, Pill } from './ui';

/**
 * Ask, and search, in one place — because they are one question asked with
 * different budgets.
 *
 * ## Why there are two buttons and not a mode switch
 *
 * **Search** ranks the corpus locally and shows you the passages. It is free,
 * offline, and nothing leaves the machine. **Ask** does exactly the same retrieval
 * and then pays a model to write prose over the result. Same passages, same
 * ranking, same citations — the only difference is whether a model composes.
 *
 * A mode switch would hide that, and hiding it is what makes people distrust a
 * grounded answer: they cannot see that the evidence came first.
 *
 * ## Why the passages are rendered, not counted
 *
 * A search that reports "4 passages found" and hides them behind a disclosure has
 * answered nothing — the passages *are* the result, and a count is a promise that
 * something exists somewhere else. So a Search turn shows them, in full, in place.
 *
 * An Ask turn folds them away by default, because there the prose is the result and
 * five full passages under it push the next question off the screen. The fold still
 * names what is inside it (`4 sources · high`), so it is a summary rather than a
 * hiding place.
 */

interface Turn {
  question: string;
  /** Set when a follow-up was rewritten before retrieval, so it can be shown. */
  searchedFor?: string;
  /** Absent on a Search turn: no model was asked, so there is no prose. */
  answer?: string;
  hits: SearchHit[];
  confidence: 'high' | 'medium' | 'low';
  coverage: string;
  mode: 'search' | 'ask';
  tokens?: { input: number; output: number };
}

const THREAD_KEY = 'autorag.thread';

/**
 * A hit as it survives `localStorage`.
 *
 * The embedding is 384 floats, and `JSON.stringify` turns a `Float32Array` into an
 * object with 384 numbered keys — about 8KB per passage, for a value nothing in
 * this component reads. Stripped on the way out and restored empty on the way back
 * in; ranking already happened, and these are its output.
 */
const strip = (h: SearchHit) => ({ ...h, chunk: { ...h.chunk, embedding: undefined } });
const restore = (h: SearchHit): SearchHit => ({
  ...h,
  chunk: { ...h.chunk, embedding: h.chunk.embedding ?? new Float32Array() },
});

export default function AskPanel({ settings }: { settings: AskSettings }) {
  const [q, setQ] = useState('');
  const [thread, setThread] = useState<Turn[]>([]);
  const [remember, setRemember] = useState(false);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState<'search' | 'ask' | null>(null);
  const [spend, setSpend] = useState({ input: 0, output: 0 });
  const [demo, setDemo] = useState<DemoUsage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  /*
   * The thread outlives a reload. Losing a conversation to a refresh is
   * indistinguishable from the product forgetting on purpose, which is the one
   * thing a memory must never appear to do.
   */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(THREAD_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { thread?: Turn[]; remember?: boolean };
        if (Array.isArray(saved.thread)) {
          setThread(saved.thread.map((t) => ({ ...t, hits: (t.hits ?? []).map(restore) })));
        }
        if (typeof saved.remember === 'boolean') setRemember(saved.remember);
      }
    } catch {
      /* an unreadable thread is an empty one, which is recoverable */
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(
        THREAD_KEY,
        JSON.stringify({ thread: thread.map((t) => ({ ...t, hits: t.hits.map(strip) })), remember }),
      );
    } catch {
      /* over quota, or private mode — the thread still works for this tab */
    }
  }, [thread, remember, loaded]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [thread.length, streaming, busy]);

  /*
   * A passage edited or discarded from a hit card below is gone from the corpus,
   * but the turn above still shows it. Re-running the search would append a turn;
   * this just drops the row, which is what the reader means by discarding it.
   */
  const dropHit = (turnIndex: number, chunkId: string) =>
    setThread((prev) =>
      prev.map((t, i) => (i === turnIndex ? { ...t, hits: t.hits.filter((h) => h.chunk.id !== chunkId) } : t)),
    );

  async function run(generate: boolean) {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(generate ? 'ask' : 'search');
    setErr(null);
    setStreaming(generate ? '' : null);

    /*
     * History travels only when Remember is on. Off, the model has never seen the
     * previous question — which is what keeps every answer traceable to the
     * passages beneath it rather than to something it said three turns ago.
     */
    const history: AskTurn[] = remember
      ? thread.flatMap((t) => [
          { role: 'user' as const, content: t.question },
          { role: 'assistant' as const, content: t.answer ?? '' },
        ])
      : [];

    try {
      /*
       * Retrieve on a query that can stand alone. On turn one that is the question
       * itself; on a follow-up it is the question with its pronouns resolved, since
       * "what about the second one?" embeds to nothing useful.
       */
      const query = generate && history.length ? await standaloneQuery(question, history, settings) : question;
      const result = await search(query, { k: 5 });
      const confidence = confidenceOf(result.hits, query, result.docs);
      const coverage = coverageNote(
        result.hits,
        result.totalCandidates,
        confidence,
        result.unmatchedTerms,
        query,
      );

      const turn: Turn = {
        question,
        ...(query !== question ? { searchedFor: query } : {}),
        hits: result.hits,
        confidence,
        coverage,
        mode: generate ? 'ask' : 'search',
      };

      if (!generate) {
        setThread((prev) => [...prev, turn]);
        setQ('');
        return;
      }

      const passages: Passage[] = result.hits.map((h) => ({
        text: h.chunk.text,
        url: h.source.url,
        title: h.source.title,
        captured: h.source.ingestedAt,
        // An image passage's source *is* the image, so the model can be shown the
        // thing itself rather than only what somebody wrote about it.
        ...(h.source.tags?.includes('image') ? { imageUrl: h.source.url } : {}),
      }));

      let answer = '';
      let tokens = { input: 0, output: 0 };
      const { demo: usage } = await askModel(
        question,
        passages,
        confidence,
        coverage,
        settings,
        (chunk) => {
          answer += chunk;
          setStreaming(answer);
        },
        history,
        (u) => {
          tokens = { input: tokens.input + u.input, output: tokens.output + u.output };
        },
      );

      if (usage) setDemo(usage);
      setSpend((prev) => ({ input: prev.input + tokens.input, output: prev.output + tokens.output }));
      setThread((prev) => [...prev, { ...turn, answer, tokens }]);
      setQ('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setStreaming(null);
    }
  }

  function clear() {
    setThread([]);
    setSpend({ input: 0, output: 0 });
    setErr(null);
  }

  const spent = spend.input + spend.output;

  return (
    <div className="chat">
      {thread.length === 0 && !busy ? (
        <div className="panel">
          <div className="panel-body">
            <h2 style={{ margin: 0, fontSize: 'var(--text-h1)', letterSpacing: '-.5px' }}>
              Ask your memory
            </h2>
            <p className="note">
              Everything you have kept, and nothing else. <strong>Search</strong> ranks your
              passages locally and shows them. <strong>Ask</strong> retrieves the same passages
              and has a model write an answer that cites them — and says so plainly when you
              never kept anything on the subject.
            </p>
          </div>
        </div>
      ) : (
        thread.map((t, i) => (
          <article className="turn" key={i}>
            <p className="turn-q">{t.question}</p>

            {t.answer && <p className="turn-a">{t.answer}</p>}
            {t.searchedFor && <p className="note">searched for &ldquo;{t.searchedFor}&rdquo;</p>}

            {t.hits.length === 0 ? (
              <Empty>Nothing you have kept covers this.</Empty>
            ) : (
              <details className="sources" {...(t.mode === 'search' ? { open: true } : {})}>
                <summary>
                  {t.hits.length} passage{t.hits.length === 1 ? '' : 's'}
                  <Pill tone={t.confidence === 'high' ? 'ok' : t.confidence === 'medium' ? 'warn' : 'bad'}>
                    {t.confidence}
                  </Pill>
                </summary>
                <div className="sources-body">
                  <p className="note">{t.coverage}</p>
                  {t.hits.map((h, n) => (
                    <Hit
                      key={h.chunk.id ?? n}
                      n={n + 1}
                      hit={h}
                      onEdited={(gone) => gone && dropHit(i, h.chunk.id)}
                    />
                  ))}
                </div>
              </details>
            )}
          </article>
        ))
      )}

      {busy && (
        <article className="turn">
          <p className="turn-q">{q}</p>
          {streaming ? (
            <p className="turn-a">{streaming}</p>
          ) : (
            <p className="note">{busy === 'ask' ? 'Reading your passages…' : 'Searching…'}</p>
          )}
        </article>
      )}

      {err && <p className="note bad">{err}</p>}
      <div ref={endRef} />

      <div className="composer">
        <div className="row">
          <Field
            placeholder="Ask about something you kept…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run(true);
            }}
          />
          <Button disabled={busy !== null || !q.trim()} onClick={() => void run(false)} title="Passages only — local and free">
            Search
          </Button>
          <Button tone="primary" disabled={busy !== null || !q.trim()} onClick={() => void run(true)}>
            {busy === 'ask' ? 'Thinking…' : 'Ask'}
          </Button>
        </div>
        <div className="composer-meta">
          <label title="Carry earlier turns into the next question">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember
          </label>
          <span className="spacer" />
          {thread.length > 0 && (
            <span>
              {thread.length} turn{thread.length === 1 ? '' : 's'}
              {spent > 0 && ` · ${spent.toLocaleString()} tokens`}
            </span>
          )}
          {!settings.apiKey && demo && (
            <span>
              {demo.used} of {demo.limit} free answers used
            </span>
          )}
          {!settings.apiKey && !demo && <span>ten free answers · add a key in Settings</span>}
          {thread.length > 0 && (
            <button className="linky" onClick={clear}>
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
