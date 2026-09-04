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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SCHEMA_SQL } from '@/src/rag/sync';
import { PERSONAL } from '@/src/rag/sessions';
import Sessions, { type SessionsApi, type SessionSummary } from '@/components/Sessions';
import {
  ASK_MODELS,
  DEFAULT_ASK_MODEL,
  PREVIEW_PAGE,
  PREVIEW_SELECTION,
  envelope,
  type AskSettings,
  type AccountState,
  type CloudSettings,
  type Event,
  type Preview,
  type Request,
  NEEDS_DESCRIPTION,
} from '../protocol';

async function ask<T>(request: Request): Promise<T | null> {
  const res = await chrome.runtime.sendMessage(envelope('worker', request));
  return res?.ok ? (res.data as T) : null;
}

/**
 * Same call, but keeps the reason it failed.
 *
 * `ask()` collapses every failure to `null`, which forced the caller to invent a
 * cause — and the invented one was "check your key", offered identically for an
 * expired key, an exhausted balance, a rate limit, a model the account cannot
 * reach, and a dropped connection. Four of those five are not the key, and being
 * told to check it sends you to re-paste something that was already correct.
 */
async function askDetailed<T>(
  request: Request,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const res = await chrome.runtime.sendMessage(envelope('worker', request));
  if (res?.ok) return { ok: true, data: res.data as T };
  return { ok: false, error: String(res?.error ?? 'no response from the extension') };
}

const toActiveTab = <T,>(what: string): Promise<T | null> =>
  chrome.runtime.sendMessage({ type: 'autorag:to-active-tab', what });

interface Conflict {
  kind: string;
  detail: string;
  against_chunk_id: string | null;
  against_text: string | null;
  agent_verdict: { ruling: string; reasoning: string; ruled_at: string } | null;
}

interface Pending {
  chunk_id: string;
  text: string;
  note: string | null;
  conflicts: Conflict[];
  source: { url: string; title: string; tags: string[] };
}

/** How an agent's ruling reads to the person who has to act on it. */
const RULING_LABEL: Record<string, string> = {
  keep_new: 'the new one supersedes the old',
  keep_existing: 'the older one is still right',
  keep_both: 'not actually a conflict',
  unresolved: 'could not tell from the text',
};

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
/**
 * What an agent on this tab can actually see — and, when the answer is nothing,
 * which of three quite different reasons applies.
 *
 * **WebMCP and capture are separate mechanisms, and conflating them is the bug this
 * fixes.** The tools live on `document.modelContext` and come from a MAIN-world
 * content script, so they exist only on ordinary web pages. Keeping things works
 * through `chrome.runtime.sendMessage` from an isolated content script or an
 * extension page, and needs no WebMCP at all. So Autorag's own PDF reader has zero
 * tools and full capture, while a page can publish all seven and still refuse to
 * give you a text selection. "No WebMCP" was reporting one of those as though it
 * described the other.
 */
function WebmcpStatus() {
  const [state, setState] = useState<{
    present: boolean;
    scheme?: string;
    tools: { name: string; description: string }[];
  } | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const read = async () =>
      setState(await chrome.runtime.sendMessage({ type: 'autorag:webmcp-status' }));
    void read();
    const timer = setInterval(read, 2000);
    return () => clearInterval(timer);
  }, []);

  const mine = (state?.tools ?? []).filter((t) => t.name.startsWith('autorag_'));

  /*
   * Three absences that look identical and are not — and every one of them is
   * about the *agent* surface only. The chip said "no WebMCP on this tab", which
   * read as "Autorag does not work here" and twice sent someone looking for a
   * fault. Nothing a person does in the panel depends on this number.
   */
  const why = !state
    ? 'A browser page. No extension can run here — including this one.'
    : state.scheme === 'chrome-extension:'
      ? 'An extension page, so WebMCP cannot run here (it is refused on extension origins). Keeping still works — the PDF reader is one of these.'
      : 'This tab has no Autorag in it — it was open before the extension loaded. Reload the page.';

  return (
    <span
      className={`chip ${mine.length ? 'ok' : ''}`}
      onClick={() => setOpen(!open)}
      style={{ cursor: 'pointer', position: 'relative' }}
      title="Click for detail"
    >
      {/* Short because the header is the narrowest row in the panel and this chip
          sits at the end of it. The detail panel below carries the explanation. */}
      {mine.length ? `agents: ${mine.length} tools` : 'agents: none'}
      {open && (
        <div className="chip-detail">
          {mine.length ? (
            <>
              <p className="note">
                What an <strong>agent</strong> driving this tab can call, with no integration
                on the site&rsquo;s part. Your own panel &mdash; keeping, Recall, Ask &mdash;
                works on every tab regardless, and never uses these.
              </p>
              {mine.map((t) => (
                <p key={t.name} className="note">
                  <strong>{t.name.replace('autorag_', '')}</strong>
                  <br />
                  {t.description.split('.')[0]}.
                </p>
              ))}
              {state && state.tools.length > mine.length && (
                <p className="note">
                  Plus {state.tools.length - mine.length} the page publishes itself.
                </p>
              )}
            </>
          ) : (
            <p className="note">{why}</p>
          )}
        </div>
      )}
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
/**
 * The shortcuts the browser *actually* assigned, which is not necessarily the ones
 * the manifest asked for.
 *
 * Chromium silently drops a suggested key it considers taken — no error, no console
 * warning, the command simply comes back with an empty shortcut. `Ctrl+Shift+S` was
 * refused on Brave for the whole build (its own screenshot tool owns it) while three
 * documents cheerfully told people to press it. Reading the real binding means the
 * panel cannot make that claim again, and says so plainly when there is none.
 */
function useShortcuts(): Record<string, string> {
  const [keys, setKeys] = useState<Record<string, string>>({});
  useEffect(() => {
    void chrome.commands.getAll().then((cmds) => {
      setKeys(Object.fromEntries(cmds.filter((c) => c.name && c.shortcut).map((c) => [c.name!, c.shortcut!])));
    });
  }, []);
  return keys;
}

const openShortcuts = () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });

/**
 * Opens a PDF in Autorag's own reader, where the text is real DOM.
 *
 * This is the primary answer for a PDF, not the paste box below it: in the
 * reader every capture path works the way it does on a web page — the Keep
 * button, the shortcut, the review queue — because there is no longer anything
 * special about the document being a PDF.
 */
const openInReader = (pdfUrl: string) =>
  void chrome.tabs.create({
    url: chrome.runtime.getURL(`reader.html?src=${encodeURIComponent(pdfUrl)}`),
  });

function CurrentTab({ onCaptured }: { onCaptured: () => void }) {
  const keys = useShortcuts();
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<React.ReactNode>(null);

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

  /*
   * The one thing that does work on a PDF: an empty editor, already pointed at
   * the PDF's own URL, waiting for a paste.
   *
   * The old message said "select the text and use Keep", which is precisely the
   * gesture that cannot work — the selection lives in Chrome's PDF plugin and no
   * extension can read it. Saying so and stopping there leaves a dead end, so
   * this opens the editor the preview flow already uses instead. Copying out of
   * the viewer works fine; it is only *reading* the selection that is blocked.
   * The passage is still stored against the PDF's URL, so recall cites the
   * document rather than a stray paste.
   */
  function openPasteBox(url: string, title: string) {
    setPreview({ text: '', title, url, isPdf: true });
    setDraft('');
    setNote(
      <>
        Chrome renders PDFs in a viewer no extension can read, so highlighting can&rsquo;t
        reach Autorag.{' '}
        <button className="linky" onClick={() => openInReader(url)}>
          Read it in Autorag
        </button>{' '}
        and highlighting works normally — or copy the passage and paste it below.
      </>,
    );
  }

  async function show(what: string) {
    setNote(null);
    const p = await toActiveTab<Preview>(what);
    if (!p) {
      /*
       * Silence from the tab has three causes and they need three different
       * sentences. The old message named PDFs for all of them, which sent people
       * looking for a problem with the page they were on; the actual cause, almost
       * always, is a tab that predates the extension and therefore has no content
       * script in it. That is now injected on install — this branch is the fallback
       * for a tab the injection could not reach, and it should say which.
       */
      const url = tab?.url ?? '';
      if (!/^https?:\/\//.test(url)) {
        return setNote('Browser pages and the extensions gallery are off limits to every extension, including this one. Try an ordinary web page.');
      }
      if (/\.pdf(\?|#|$)/i.test(url)) {
        return openPasteBox(url, tab?.title || url);
      }
      return setNote(
        <>
          This tab has no Autorag in it — it was open before the extension was loaded
          or reloaded.{' '}
          <button className="linky" onClick={() => tab?.id && chrome.tabs.reload(tab.id)}>
            Reload the page
          </button>{' '}
          and it will work.
        </>,
      );
    }
    /*
     * Before the length check, not after. A PDF answers this message — the
     * content script does run on the tab — it just answers with an empty string,
     * every time, however much is highlighted. Read as a length that made the
     * panel say "nothing is highlighted" to someone looking at their own
     * highlight, and it meant the PDF branch above almost never ran, since it
     * only fires when the tab does not answer at all.
     */
    if (p.isPdf) return openPasteBox(p.url, p.title);
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
      <h2>This page</h2>
      <div className="card">
        <span className="src" title={tab?.url}>
          {tab?.title || tab?.url || 'no active tab'}
        </span>

        {preview ? (
          <>
            <p className="note">
              {preview.isPdf && !draft.trim()
                ? 'Nothing pasted yet.'
                : `${words(draft)} words · ${draft.length} characters. Trim it before keeping if you only want part.`}
            </p>
            <textarea
              className="preview"
              value={draft}
              placeholder={preview.isPdf ? 'Paste the passage from the PDF here…' : undefined}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="row">
              <button className="primary" onClick={commit} disabled={busy || draft.trim().length < 50}>
                {busy ? 'Keeping…' : `Keep ${words(draft)} words`}
              </button>
              <button
                onClick={() => {
                  setPreview(null);
                  setNote(null);
                }}
                disabled={busy}
              >
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
              Or highlight anything and click <strong>Keep</strong>.{' '}
              {keys['keep-selection'] ? (
                <>
                  <kbd>{keys['keep-selection']}</kbd> does it too.
                </>
              ) : (
                <>
                  The keyboard shortcut for this is{' '}
                  <strong>unassigned — the browser refused it</strong>, usually because
                  something else already owns that combination.{' '}
                  <button className="linky" onClick={openShortcuts}>
                    Assign one
                  </button>
                  .
                </>
              )}
            </p>
          </>
        )}

        {note && <p className="note warn">{note}</p>}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ corpus */

interface Source {
  source_id: string;
  url: string;
  title: string;
  stale: boolean;
  stale_reason: string | null;
  ingested_at: string;
  approved: number;
  pending: number;
  rejected: number;
}

/**
 * Everything you have kept, and the two ways to change your mind about it.
 *
 * Marking a source out of date is the one to reach for: its passages stay
 * searchable but rank lower and come back flagged, so the record of what you once
 * believed survives. Forgetting is permanent and asks twice.
 */
function Corpus({ onChange, count }: { onChange: () => void; count?: number }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setSources((await ask<Source[]>({ kind: 'listSources' })) ?? []);
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  async function act(request: Request) {
    await ask(request);
    setConfirming(null);
    await refresh();
    onChange();
  }

  return (
    <section>
      <h2>
        <button className="linky" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} Sources{' '}
          {/* From stats, not from `sources`: that list only loads when the section
              is opened, so a closed one used to claim the corpus was empty. */}
          <span className="soft">{count ?? '…'}</span>
        </button>
      </h2>

      {open && (
        <>
          {sources.length === 0 ? (
            <p className="empty">Nothing kept yet.</p>
          ) : (
            sources.map((s) => (
              <div key={s.source_id} className="card">
                <a className="src" href={s.url} target="_blank" rel="noreferrer">
                  {s.title || s.url}
                </a>
                <p className="note">
                  {s.approved} kept
                  {s.pending > 0 && ` · ${s.pending} awaiting review`}
                  {s.rejected > 0 && ` · ${s.rejected} discarded`} ·{' '}
                  {new Date(s.ingested_at).toLocaleDateString()}
                </p>
                {s.stale && (
                  <p className="note warn">
                    Out of date — demoted in ranking. {s.stale_reason}
                  </p>
                )}
                <div className="row">
                  {s.stale ? (
                    <button
                      onClick={() => act({ kind: 'markStale', sourceId: s.source_id, stale: false })}
                    >
                      Still current
                    </button>
                  ) : (
                    <button
                      onClick={() =>
                        act({
                          kind: 'markStale',
                          sourceId: s.source_id,
                          stale: true,
                          reason: 'Marked out of date from the panel.',
                        })
                      }
                    >
                      Mark out of date
                    </button>
                  )}
                  {confirming === s.source_id ? (
                    <button className="danger" onClick={() => act({ kind: 'forget', sourceId: s.source_id })}>
                      Really forget?
                    </button>
                  ) : (
                    <button className="danger" onClick={() => setConfirming(s.source_id)}>
                      Forget
                    </button>
                  )}
                </div>
              </div>
            ))
          )}

          {sources.length > 0 && (
            <div className="row" style={{ marginTop: 4 }}>
              {confirming === '__all__' ? (
                <button className="danger" onClick={() => act({ kind: 'wipe' })}>
                  Really erase everything?
                </button>
              ) : (
                <button className="danger" onClick={() => setConfirming('__all__')}>
                  Erase the whole corpus
                </button>
              )}
            </div>
          )}
        </>
      )}
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [note, setNote] = useState(item.note ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dirty = draft.trim() !== item.text.trim() || note.trim() !== (item.note ?? '').trim();

  /*
   * An image the page said nothing about. It is staged rather than refused — most of
   * the web captions nothing, and refusing turned away screenshots and charts while
   * waving through any logo with a dutiful alt attribute. What it cannot do is enter
   * the memory undescribed, because nothing would ever retrieve it: the index is
   * text, and its only text would be a URL.
   *
   * So the queue shows the picture and holds the Keep button until a person has
   * written what it is. Steering, not security (amendments A1, A4) — the sentinel is
   * in the text they are editing and they can delete it. The point is that keeping it
   * blind takes a deliberate act, not an accidental click.
   */
  const isImage = item.source.tags?.includes('image');
  const undescribed = draft.includes(NEEDS_DESCRIPTION);

  /*
   * Editing before deciding, because the review step is where you find out the
   * capture dragged in a cookie banner or clipped a sentence in half. Saving
   * re-embeds and re-screens on the way through — so the passage that gets
   * approved is the passage that was screened, not the one that arrived.
   */
  async function save() {
    setSaving(true);
    setErr(null);
    const res = await askDetailed({
      kind: 'revisePending',
      chunkId: item.chunk_id,
      ...(draft.trim() !== item.text.trim() ? { text: draft.trim() } : {}),
      note,
    });
    setSaving(false);
    // The reason it refused, not a guess at one. "Needs 50 characters" was
    // offered for every failure — including a passage that was already approved,
    // where the length was fine and the advice was nonsense.
    if (!res.ok) return setErr(res.error);
    setEditing(false);
    onDone();
  }

  return (
    <div className="card">
      <a className="src" href={item.source.url} target="_blank" rel="noreferrer">
        {item.source.title || item.source.url}
      </a>

      {isImage && (
        <img
          className="thumb"
          src={item.source.url}
          alt=""
          onError={(e) => (e.currentTarget.style.display = 'none')}
        />
      )}
      {undescribed && (
        <p className="note warn needs-desc">
          The page said nothing about this image. Describe what it shows — otherwise
          nothing will ever find it, because the index is text.
        </p>
      )}

      {editing || undescribed ? (
        <>
          <textarea className="preview" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <p className="note">
            {words(draft)} words. Editing re-screens it, so the flags below may change.
          </p>
        </>
      ) : (
        <p className="text">{item.text}</p>
      )}

      <input
        className="note-input"
        placeholder="Add a note — why this matters, what to distrust (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {!editing && <p className="note">{words(item.text)} words</p>}
      {err && <p className="note warn">{err}</p>}

      {item.conflicts.map((c, i) => (
        <div key={i} className="conflict">
          <span className="badge">{c.kind.replace('_', ' ')}</span>
          <span>{c.detail}</span>
          {/*
            An agent's ruling, if one has been made. Rendered as a distinct block
            rather than folded into the flag text: screening's line is a machine
            nominating, this is a reading of both passages, and conflating them
            would hide which of the two you are trusting.
          */}
          {c.agent_verdict && (
            <div className="verdict">
              <span className="badge verdict-badge">
                agent: {RULING_LABEL[c.agent_verdict.ruling] ?? c.agent_verdict.ruling}
              </span>
              <span>{c.agent_verdict.reasoning}</span>
              <span className="note">Advisory. You still decide.</span>
            </div>
          )}
        </div>
      ))}

      {rejecting ? (
        <>
          <input
            autoFocus
            placeholder="Why not? Optional — replayed if this comes back"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {/*
           * Discard is enabled with the box empty on purpose. A reason is genuinely
           * useful — screening replays it when similar material returns — but
           * demanding one turns throwing something away into a small essay, and the
           * result is people leaving junk in the queue rather than writing a sentence
           * about it. The reason is an offer, not a toll.
           */}
          <div className="row">
            <button
              className="danger"
              onClick={async () => {
                await ask({
                  kind: 'reject',
                  chunkIds: [item.chunk_id],
                  ...(reason.trim() ? { reason: reason.trim() } : {}),
                });
                onDone();
              }}
            >
              {reason.trim() ? 'Discard with reason' : 'Discard'}
            </button>
            <button onClick={() => setRejecting(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <div className="row">
          <button
            className="primary"
            disabled={saving || undescribed}
            title={undescribed ? 'Describe the image first — nothing could find it otherwise.' : undefined}
            onClick={async () => {
              if (dirty) await save();
              await ask({ kind: 'approve', chunkIds: [item.chunk_id] });
              onDone();
            }}
          >
            {saving ? 'Saving…' : undescribed ? 'Describe it first' : 'Keep'}
          </button>
          {editing && !undescribed ? (
            <>
              <button onClick={save} disabled={saving || !dirty}>
                Save edit
              </button>
              <button
                onClick={() => {
                  setDraft(item.text);
                  setEditing(false);
                  setErr(null);
                }}
              >
                Cancel
              </button>
            </>
          ) : undescribed ? (
            <button onClick={save} disabled={saving || !dirty}>
              Save description
            </button>
          ) : (
            <button onClick={() => setEditing(true)}>Edit</button>
          )}
          <button onClick={() => setRejecting(true)}>Discard…</button>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- settings */

/**
 * Where the answering model lives. Read once, written on change.
 *
 * `chrome.storage.local`, never `sync`: an API key should not be copied to
 * every browser signed into the same account as a side effect of typing it here.
 */
function useAskSettings(): [AskSettings, (next: AskSettings) => void] {
  const [settings, setSettings] = useState<AskSettings>({ apiKey: '', model: DEFAULT_ASK_MODEL });
  useEffect(() => {
    void chrome.storage.local.get(['askApiKey', 'askModel']).then((v) =>
      setSettings({
        apiKey: String(v.askApiKey ?? ''),
        model: String(v.askModel ?? DEFAULT_ASK_MODEL),
      }),
    );
  }, []);
  const save = (next: AskSettings) => {
    setSettings(next);
    void chrome.storage.local.set({ askApiKey: next.apiKey, askModel: next.model });
  };
  return [settings, save];
}

/**
 * The one place Autorag spends money, and the one place it sends anything off the
 * device — so both facts are stated here rather than in a README nobody opens.
 */
function AnswerSettings({
  settings,
  save,
}: {
  settings: AskSettings;
  save: (next: AskSettings) => void;
}) {
  const [draft, setDraft] = useState('');
  const model = ASK_MODELS.find((m) => m.id === settings.model) ?? ASK_MODELS[0];

  return (
    <section>
      <h2>
        Answers <span className="soft">{settings.apiKey ? model.label : 'off'}</span>
      </h2>
      <div className="card">
          <p className="note">
            Without a key, Recall returns passages and nothing leaves your machine. With one,
            Autorag also writes an answer from those passages — <strong>your question and the
            passages it retrieved are sent to the model provider.</strong> Capture, review,
            indexing and search stay local either way.
          </p>
          <div className="row">
            <input
              type="password"
              placeholder={settings.apiKey ? 'Key saved — type to replace' : 'Anthropic API key'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              onClick={() => {
                save({ ...settings, apiKey: draft.trim() });
                setDraft('');
              }}
              disabled={!draft.trim()}
            >
              Save
            </button>
            {settings.apiKey && (
              <button className="danger" onClick={() => save({ ...settings, apiKey: '' })}>
                Remove
              </button>
            )}
          </div>
          <div className="row">
            {ASK_MODELS.map((m) => (
              <button
                key={m.id}
                className={m.id === settings.model ? 'primary' : ''}
                onClick={() => save({ ...settings, model: m.id })}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="note">
            {model.label}: ${model.input}/M in, ${model.output}/M out. An answer over five
            passages runs a few thousand tokens — well under a cent. Nothing calls the model
            unless you ask a question.
          </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------- cloud */

const EMPTY_CLOUD: CloudSettings = { url: '', anonKey: '' };

function useCloud(): [CloudSettings, (next: CloudSettings) => void] {
  const [cloud, setCloud] = useState<CloudSettings>(EMPTY_CLOUD);
  useEffect(() => {
    void chrome.storage.local
      .get('cloud')
      .then((v) => setCloud((v.cloud as CloudSettings) ?? EMPTY_CLOUD));
  }, []);
  const save = (next: CloudSettings) => {
    setCloud(next);
    void chrome.storage.local.set({ cloud: next });
  };
  return [cloud, save];
}

/**
 * Memory mode: this device, or this device and every other one you sign into.
 *
 * Local is the default and stays free, offline and private. Cloud is opt-in with
 * the person's own project and their own bill — the same bargain as the answering
 * key, and for the same reason: we are not billed for someone else's convenience,
 * and their data is genuinely theirs.
 */
function Memory({
  cloud,
  save,
  onSynced,
}: {
  cloud: CloudSettings;
  save: (next: CloudSettings) => void;
  onSynced: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(cloud.url);
  const [key, setKey] = useState(cloud.anonKey);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<React.ReactNode>(null);
  /*
   * Open by default for anyone who has not configured a project yet.
   *
   * These steps used to be behind a link, which is the wrong default: the person
   * who needs them is precisely the person who does not yet know they exist, and
   * without running the script first, Sign in can only fail. Someone returning to
   * a configured panel gets it collapsed, because for them it is noise.
   */
  const [showSql, setShowSql] = useState(!cloud.url);
  const [copied, setCopied] = useState(false);

  const signedIn = Boolean(cloud.accessToken);

  async function connect(create: boolean) {
    setBusy(create ? 'creating' : 'signing in');
    setMsg(null);
    const next = { ...cloud, url: url.trim(), anonKey: key.trim() };
    /*
     * Attaches a project. It does not create an account, and that distinction is
     * what was broken here.
     *
     * This used to call `cloudSignIn`, which signed into the project *and* tried to
     * make a matching directory account from the same password. Once the two were
     * separated those passwords stopped being the same thing, so the directory half
     * failed — usually with "already registered" — and left the panel with a
     * working project and no identity. Creating a session then failed with "Sign in
     * first" while the person was demonstrably signed in to their project, and no
     * profile was ever published, so any session they did make resolved to nothing
     * for everyone they gave the code to.
     *
     * Identity comes from the web app and arrives already mirrored. This only needs
     * the project.
     */
    const res = await askDetailed<{
      url: string;
      anonKey: string;
      accessToken: string;
      refreshToken: string;
      userId: string;
    }>({
      kind: 'attachProject',
      url: url.trim(),
      anonKey: key.trim(),
      email: email.trim(),
      password,
      create,
    });
    setBusy(null);
    if (!res.ok) return setMsg(res.error);
    const connected = { ...next, ...res.data };
    save(connected);
    setPassword('');
    // Push immediately rather than leaving it to a button. Signing in and seeing
    // an empty table is indistinguishable from sync being broken.
    setBusy('syncing');
    const first = await askDetailed<{ pushed: number; pulled: number }>({
      kind: 'sync',
      cloud: connected,
    });
    setBusy(null);
    setMsg(
      <>
        {first.ok
          ? `Signed in and synced — ${first.data.pushed} row(s) up, ${first.data.pulled} down.`
          : `Signed in, but the first sync failed: ${first.error}`}
        {/*
          Said out loud rather than left to be discovered. Without a directory
          account nothing about the corpus is broken, but every session this
          person creates resolves to nothing for everyone they give the code to —
          and they would have no way to tell that from the other side.
        */}

      </>,
    );
    onSynced();
  }

  async function sync() {
    setBusy('syncing');
    setMsg(null);
    const res = await askDetailed<{ pulled: number; deleted: number }>({ kind: 'sync', cloud });
    setBusy(null);
    if (!res.ok) return setMsg(res.error);
    setMsg(`Synced · ${res.data.pulled} new here, ${res.data.deleted} removed elsewhere.`);
    onSynced();
  }

  return (
    <section>
      <h2>
        Memory <span className="soft">{signedIn ? cloud.email : 'this device'}</span>
      </h2>
      <div className="card">
          <p className="note">
            {signedIn
              ? 'Your memory syncs to your Supabase project — sign in on another browser and it is there.'
              : 'Local by default: free, offline, nothing leaves this machine. Connect a Supabase project and your memory follows you to any device you sign into.'}
          </p>
          {/*
            Said before anything is uploaded, in these words, because it is a
            larger step than the answering key: that sends a question and the few
            passages it retrieved. This sends everything you have ever kept.
          */}
          {!signedIn && (
            <p className="note bad">
              Cloud mode uploads your <strong>whole corpus</strong>, including everything kept
              before you switch — not just what a question retrieves.
            </p>
          )}
          {!signedIn && (
            <>
              <div className="row">
                <input placeholder="https://xxxx.supabase.co" value={url} onChange={(e) => setUrl(e.target.value)} />
              </div>
              <div className="row">
                <input placeholder="anon public key" value={key} onChange={(e) => setKey(e.target.value)} />
              </div>
              <div className="row">
                {/*
                  The project's own login, prefilled from the account. Usually the
                  same address — most people sign up for both with one email — but
                  it need not be: the project may predate the account or sit on a
                  work address. Prefilled so the common case is not retyped, and
                  editable so the uncommon one is not a dead end.
                */}
                <input
                  placeholder="email for this project"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="row">
                <input
                  type="password"
                  placeholder="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="row">
                <button className="primary" onClick={() => void connect(false)} disabled={busy !== null}>
                  {busy === 'signing in' ? '…' : 'Sign in'}
                </button>
                <button onClick={() => void connect(true)} disabled={busy !== null}>
                  {busy === 'creating' ? '…' : 'Create account'}
                </button>
                <button className="linky inline" onClick={() => setShowSql(!showSql)}>
                  {showSql ? 'hide setup steps' : 'first time? setup steps'}
                </button>
              </div>
              {showSql && (
                <>
                  {/*
                    Both of these were discovered by failing, which is the wrong way
                    round. The account confusion produces "Invalid login
                    credentials" — accurate and useless — and the confirmation
                    default sends you to a localhost:3000 link that nothing serves.
                  */}
                  <p className="note">
                    <strong>1.</strong> In Supabase → SQL editor, run the script below.
                    <br />
                    <strong>2.</strong> Authentication → Sign In / Providers → Email → turn
                    off <strong>Confirm email</strong>. An extension has no address for a
                    confirmation link to return to; left on, the link points at{' '}
                    <code>localhost:3000</code> and fails.
                    <br />
                    <strong>3.</strong> Use <strong>Create account</strong> below with any
                    email and password. This is a user <em>inside your project</em> — not
                    your supabase.com login, which does not exist here.
                  </p>
                  <textarea className="preview" readOnly value={SCHEMA_SQL} style={{ height: 160 }} />
                  {/*
                    A copy button rather than leaving people to select 30 lines
                    inside a scrolling textarea, where missing the last line
                    produces a project that is silently short an index.
                  */}
                  <div className="row">
                    <button
                      onClick={() => {
                        void navigator.clipboard.writeText(SCHEMA_SQL).then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        });
                      }}
                    >
                      {copied ? 'Copied' : 'Copy SQL'}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
          {signedIn && (
            <div className="row">
              <button className="primary" onClick={() => void sync()} disabled={busy !== null}>
                {busy === 'syncing' ? 'Syncing…' : 'Sync now'}
              </button>
              <button
                className="danger"
                onClick={() => save({ url: cloud.url, anonKey: cloud.anonKey })}
              >
                Sign out
              </button>
            </div>
          )}
          {msg && <p className="note">{msg}</p>}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ recall */

/**
 * One search result, editable in place.
 *
 * The Edit button lives here rather than only in the review queue because this is
 * where you *notice*. A passage that captured a cookie banner or clipped a
 * sentence looks fine until it comes back in a search, and at that moment the only
 * previous option was to forget the whole source and keep it again.
 *
 * Editing an approved passage returns it to the review queue — approval means a
 * person vouched for what it said, so changing the text withdraws that. The note
 * below says so before you start typing, not after you save.
 */
function Hit({
  n,
  hit,
  onEdited,
}: {
  n: number;
  hit: { chunk: { id?: string; text: string }; source: { url: string; title: string } };
  /** `gone` is true when the passage left the corpus, so the caller can drop it. */
  onEdited: (gone: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [reason, setReason] = useState('');
  const [draft, setDraft] = useState(hit.chunk.text);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /**
   * Removes one passage from the corpus without touching the rest of its source.
   *
   * Previously the only way was to forget the whole page, which threw away every
   * other passage kept from it to remove one. The reason is optional and, like a
   * discard from the review queue, is replayed if the same material comes back —
   * so a thing you rejected once tells you why the next time you nearly keep it.
   */
  async function discard() {
    setSaving(true);
    setErr(null);
    const res = await askDetailed({
      kind: 'reject',
      chunkIds: [hit.chunk.id ?? ''],
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
    setSaving(false);
    if (!res.ok) return setErr(res.error);
    setDiscarding(false);
    onEdited(true);
  }

  async function save() {
    setSaving(true);
    setErr(null);
    const res = await askDetailed({
      kind: 'revisePending',
      chunkId: hit.chunk.id ?? '',
      text: draft.trim(),
    });
    setSaving(false);
    if (!res.ok) return setErr(res.error);
    setEditing(false);
    // An edit sends the passage back to the review queue, so it leaves the corpus
    // too — until you approve it again.
    onEdited(true);
  }

  return (
    <div className="card">
      <a className="src" href={hit.source.url} target="_blank" rel="noreferrer">
        {/* Numbered to match the [1], [2] citations in the answer above. */}
        [{n}] {hit.source.title || hit.source.url}
      </a>
      {editing ? (
        <>
          <textarea className="preview" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <p className="note">
            Saving sends this back to <strong>To review</strong> — it was approved as it
            reads now, and changing it withdraws that.
          </p>
          <div className="row">
            <button
              className="primary"
              onClick={save}
              disabled={saving || draft.trim() === hit.chunk.text.trim()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => {
                setDraft(hit.chunk.text);
                setEditing(false);
                setErr(null);
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : discarding ? (
        <>
          <p className="text">{hit.chunk.text}</p>
          <input
            autoFocus
            placeholder="Why not? Optional — replayed if this comes back"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void discard()}
          />
          <div className="row">
            <button className="danger" onClick={discard} disabled={saving}>
              {saving ? 'Discarding…' : 'Discard this passage'}
            </button>
            <button onClick={() => setDiscarding(false)} disabled={saving}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text">{hit.chunk.text}</p>
          <div className="row">
            <button className="linky inline" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className="linky inline" onClick={() => setDiscarding(true)}>
              Discard
            </button>
          </div>
        </>
      )}
      {err && <p className="note bad">{err}</p>}
    </div>
  );
}

interface RecallResult {
  answer?: string;
  hits: { chunk: { id?: string; text: string }; source: { url: string; title: string } }[];
  confidence: string;
  coverage_note: string;
  tokens?: { input: number; output: number };
  images_sent?: number;
  /** Present when a follow-up was rewritten before retrieval. */
  searched_for?: string;
}

/** One exchange, kept only while Remember is on. */
interface Exchange {
  question: string;
  result: RecallResult;
}

/**
 * A conversation, not a form.
 *
 * This was a text input, two buttons, an answer block and a list of passages
 * stacked under it — every part the same weight, and the passages pushing the next
 * question further off screen with each turn. Three things were wrong with that:
 * the thread vanished when the panel closed, the sources competed with the answer
 * for the same vertical space, and nothing about it read like talking to anything.
 *
 * Now: the transcript scrolls, the composer is pinned to the bottom, and the
 * sources for the current answer live in a drawer at the foot of the pane — one
 * line when shut, a sheet when open. The thread survives closing the panel.
 */
function Recall({ settings }: { settings: AskSettings }) {
  const [q, setQ] = useState('');
  const [thread, setThread] = useState<Exchange[]>([]);
  const [remember, setRemember] = useState(false);
  const [spend, setSpend] = useState({ input: 0, output: 0 });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<'search' | 'ask' | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  /*
   * The thread outlives the panel. A side panel closes whenever you click the
   * toolbar icon or switch windows, and losing a conversation to that is
   * indistinguishable from the product forgetting on purpose — which is the one
   * thing this product must never appear to do.
   */
  useEffect(() => {
    void chrome.storage.local.get(['thread', 'remember', 'spend']).then((v) => {
      if (Array.isArray(v.thread)) setThread(v.thread as Exchange[]);
      if (typeof v.remember === 'boolean') setRemember(v.remember);
      if (v.spend) setSpend(v.spend as { input: number; output: number });
      setLoaded(true);
    });
  }, []);
  useEffect(() => {
    if (loaded) void chrome.storage.local.set({ thread, remember, spend });
  }, [thread, remember, spend, loaded]);

  const last = thread[thread.length - 1];
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [thread.length, busy]);

  async function run(generate: boolean) {
    if (!q.trim()) return;
    setBusy(generate ? 'ask' : 'search');
    setErr(null);
    const question = q.trim();
    /*
     * History only travels when Remember is on. Off, the model has never seen the
     * previous question — which is what keeps every answer traceable to the
     * passages beneath it rather than to something it said three turns ago.
     */
    const history = remember
      ? thread.flatMap((t) => [
          { role: 'user' as const, content: t.question },
          { role: 'assistant' as const, content: t.result.answer ?? '' },
        ])
      : [];
    const res = await askDetailed<RecallResult>(
      generate ? { kind: 'ask', question, settings, history } : { kind: 'answer', question },
    );
    setBusy(null);
    if (!res.ok) return setErr(res.error);
    setThread((prev) => [...prev, { question, result: res.data }]);
    setQ('');
    setSourcesOpen(false);
    if (res.data.tokens) {
      setSpend((prev) => ({
        input: prev.input + res.data.tokens!.input,
        output: prev.output + res.data.tokens!.output,
      }));
    }
  }

  function clear() {
    setThread([]);
    setSpend({ input: 0, output: 0 });
    setErr(null);
    setSourcesOpen(false);
  }

  return (
    <div className="chat">
      <div className="transcript">
        {thread.length === 0 && !busy && (
          <div className="hello">
            <h2>Ask your memory</h2>
            <p className="note">
              Everything you have kept, and nothing else. Answers cite the page each claim
              came from, and say so plainly when you never kept anything on the subject.
            </p>
          </div>
        )}

        {thread.map((t, i) => (
          <div key={i} className="turn">
            <p className="q">{t.question}</p>
            <div className="a">
              {t.result.answer ? (
                <p className="text">{t.result.answer}</p>
              ) : (
                <p className="note">
                  {t.result.hits.length} passage{t.result.hits.length === 1 ? '' : 's'} found.
                  Open sources below.
                </p>
              )}
              {t.result.searched_for && (
                <p className="meta">searched for &ldquo;{t.result.searched_for}&rdquo;</p>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="turn">
            <p className="q">{q}</p>
            <div className="a">
              <p className="note">{busy === 'ask' ? 'Reading your passages…' : 'Searching…'}</p>
            </div>
          </div>
        )}
        {err && <p className="note bad">{err}</p>}
        <div ref={endRef} />
      </div>

      {/*
        Sources at the foot of the pane rather than under the answer. Under it they
        pushed the next question off screen and competed with the thing you asked
        for; here they are one line until you want them.
      */}
      {last && (
        <div className={sourcesOpen ? 'drawer open' : 'drawer'}>
          <button className="drawer-bar" onClick={() => setSourcesOpen(!sourcesOpen)}>
            <span className="caret" />
            {last.result.hits.length} source{last.result.hits.length === 1 ? '' : 's'}
            {last.result.images_sent ? ` · ${last.result.images_sent} image read` : ''}
            <span className={`badge conf-${last.result.confidence}`}>
              {last.result.confidence}
            </span>
          </button>
          {sourcesOpen && (
            <div className="drawer-body">
              <p className="note">{last.result.coverage_note}</p>
              {last.result.hits.map((h, i) => (
                <Hit
                  key={h.chunk.id ?? i}
                  n={i + 1}
                  hit={h}
                  /*
                   * Update this turn in place. The old handler re-ran the search,
                   * which in a form appended nothing and in a conversation appends
                   * a whole new turn — so discarding a source looked like it did
                   * nothing while quietly starting another exchange.
                   */
                  onEdited={(gone) =>
                    setThread((prev) =>
                      prev.map((t, ti) =>
                        ti !== prev.length - 1
                          ? t
                          : {
                              ...t,
                              result: {
                                ...t.result,
                                hits: gone
                                  ? t.result.hits.filter((x) => x.chunk.id !== h.chunk.id)
                                  : t.result.hits,
                              },
                            },
                      ),
                    )
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="composer">
        <div className="row">
          <input
            placeholder="Ask your memory…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run(Boolean(settings.apiKey))}
          />
          <button onClick={() => run(false)} disabled={busy !== null} title="Passages only, local and free">
            Search
          </button>
          <button
            className="primary"
            onClick={() => run(true)}
            disabled={busy !== null || !settings.apiKey}
            title={settings.apiKey ? 'Write an answer from the passages' : 'Add a key in Settings'}
          >
            Ask
          </button>
        </div>
        <div className="composer-meta">
          <label>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => {
                setRemember(e.target.checked);
              }}
            />
            Remember
          </label>
          <span className="spacer" />
          {thread.length > 0 && (
            <>
              <span>
                {thread.length} turn{thread.length === 1 ? '' : 's'}
                {spend.input + spend.output > 0 &&
                  ` · ${(spend.input + spend.output).toLocaleString()} tokens`}
              </span>
              <button className="linky inline" onClick={clear}>
                Clear
              </button>
            </>
          )}
          {!settings.apiKey && <span>Search only — add a key in Settings</span>}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- app */

/**
 * Three tabs, split by what you are doing rather than by what the code does.
 *
 * Everything used to be one column: capture, queue, search, model settings, cloud
 * settings and an activity log, all stacked and all visible. Every section looked
 * the same weight, so the panel read as a list of controls to work through rather
 * than a place with a few things you might want.
 *
 *   Ask       a question and its answer, with the passages it used
 *   Library   what comes in and what is kept: this page, the queue, search
 *   Settings  the two things you configure once, plus the activity log
 *
 * The badge on Library is the only thing that pulls for attention, and only when
 * something is actually waiting.
 */

/**
 * Sessions: which corpus you are keeping into, and who else is in it.
 *
 * The heading always says whose database you are writing to, and that is not
 * decoration. Joining someone else's session means every passage you keep lands in
 * *their* project — the one thing here a person could do without realising, and
 * the one thing they cannot undo from their own machine.
 */
/**
 * The panel's half of the session UI.
 *
 * The component itself is shared with the web app (`components/Sessions.tsx`) so
 * the two surfaces cannot drift into offering different sessions or different
 * warnings. Only the operations differ: here they message the offscreen document
 * that owns the corpus, where the web app calls the engine in its own page.
 *
 * There is no account form. Identity is created in the web app and mirrored here,
 * which is what makes signing into two different accounts impossible rather than
 * merely discouraged.
 */
/**
 * Who is signed in, according to the web app.
 *
 * ## Why this polls
 *
 * Identity is created in the web app and pushed here, but the push only fires when
 * the app is open and something changes. Somebody who opens the panel, finds they
 * are signed out, signs in on the app and comes back must not be looking at a
 * stale "sign in first" screen — so this asks again on a timer, and stops asking
 * once there is an answer. Two seconds is fast enough that the panel has caught up
 * before you have finished switching tabs.
 *
 * The button opens the app rather than explaining where to find it. "Sign in on
 * the web app" with no way to get there is a dead end, and the panel already knows
 * the URL.
 *
 * There is deliberately no account form here. Identity is created in one place, and
 * that is what makes being signed into two different accounts impossible rather
 * than merely discouraged.
 */
const APP_URL = 'https://autorag-web.netlify.app/';

function AccountGate({
  account,
  onRecheck,
  onGuest,
}: {
  account: AccountState | null;
  onRecheck: () => void;
  onGuest?: () => void;
}) {
  if (account) {
    return (
      <p className="note">
        Signed in as <strong>{account.demo ? 'demo account' : account.email || 'guest'}</strong>
        {account.host ? ` · in ${account.host.name}` : account.sessionId ? ` · ${account.sessionId}` : ''}
      </p>
    );
  }
  return (
    <div className="card">
      <p className="note">
        Sign in on the web app and this panel picks it up automatically — there is no separate
        account here, on purpose.
      </p>
      <div className="row">
        <button className="primary" onClick={() => void chrome.tabs.create({ url: APP_URL })}>
          Sign in
        </button>
        <button onClick={onRecheck}>Check again</button>
      </div>
      {onGuest && (
        <>
          <p className="note">
            Or work without an account. Everything stays in this browser — you can keep,
            review, search and ask, but not join sessions or sync anywhere. You can sign in
            later and keep what you gathered.
          </p>
          <div className="row">
            <button onClick={onGuest}>Continue as guest</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Reads the mirrored account, and keeps asking until there is one. */
function useAccount(): [AccountState | null, () => void, boolean] {
  const [account, setAccount] = useState<AccountState | null>(null);
  const [ready, setReady] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    const read = async () => {
      const a = await ask<AccountState | null>({ kind: 'getAccount' });
      if (live) {
        setAccount(a);
        setReady(true);
      }
      return a;
    };
    void read();
    /*
     * Only while signed out. Once an account is here, polling buys nothing and
     * would wake the offscreen document every two seconds for the life of the
     * panel.
     */
    const timer = setInterval(async () => {
      if (await read()) clearInterval(timer);
    }, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [nonce]);

  return [account, () => setNonce((n) => n + 1), ready];
}

function PanelSessions({
  cloud,
  save,
  account,
  onChanged,
}: {
  cloud: CloudSettings;
  save: (next: CloudSettings) => void;
  account: AccountState | null;
  onChanged: () => void;
}) {
  const api: SessionsApi = useMemo(
    () => ({
      list: async () => {
        // One call. An earlier version asked twice — once to test `ok` and again
        // to read `data` — which doubled every refresh against the directory.
        const res = await askDetailed<SessionSummary[]>({ kind: 'listSessions', cloud });
        return res.ok ? res.data : [];
      },
      create: async (name, openJoin) => {
        const res = await askDetailed<{ code: string; name: string }>({
          kind: 'createSession',
          cloud,
          name,
          openJoin,
        });
        if (!res.ok) throw new Error(res.error);
        return res.data;
      },
      join: async (code) => {
        const res = await askDetailed<{
          code: string;
          host: { url: string; anonKey: string; name: string };
        }>({ kind: 'joinSession', cloud, code });
        if (!res.ok) throw new Error(res.error);
        return res.data;
      },
      invite: async (code, email) => {
        const res = await askDetailed({ kind: 'inviteToSession', cloud, code, email });
        if (!res.ok) throw new Error(res.error);
      },
      switchTo: async (target) => {
        const next: CloudSettings = {
          ...cloud,
          sessionId: target?.id,
          host: target?.host,
        };
        save(next);
        const res = await askDetailed<{ pulled: number }>({ kind: 'sync', cloud: next });
        if (!res.ok) throw new Error(res.error);
        return { pulled: res.data.pulled };
      },
    }),
    [cloud, save],
  );

  return (
    <Sessions
      api={api}
      activeSessionId={cloud.sessionId ?? PERSONAL}
      hostedName={cloud.host?.name}
      canHost={Boolean(cloud.url && cloud.anonKey && cloud.accessToken)}
      signedIn={Boolean(account?.directory)}
      onChanged={onChanged}
    />
  );
}


type Tab = 'ask' | 'library' | 'settings';

/** When cloud sync last succeeded, or what went wrong. */
function SyncStatus() {
  const [state, setState] = useState<{ at?: number; error?: string }>({});
  useEffect(() => {
    const read = () =>
      void chrome.storage.local
        .get(['lastSyncAt', 'lastSyncError'])
        .then((v) => setState({ at: v.lastSyncAt as number, error: v.lastSyncError as string }));
    read();
    const timer = setInterval(read, 3000);
    return () => clearInterval(timer);
  }, []);

  if (state.error) return <span className="leaves">Sync failed — {state.error}</span>;
  if (!state.at) return <span>Cloud connected · not synced yet</span>;
  const secs = Math.round((Date.now() - state.at) / 1000);
  const ago = secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`;
  return <span>Synced {ago} ago</span>;
}

function App() {
  const [account, recheckAccount, accountReady] = useAccount();
  const [tab, setTab] = useState<Tab>('library');
  const [pending, setPending] = useState<Pending[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [settings, saveSettings] = useAskSettings();
  const [cloud, saveCloud] = useCloud();

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

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'ask', label: 'Ask' },
    { id: 'library', label: 'Library', badge: pending.length },
    { id: 'settings', label: 'Settings' },
  ];

  /*
   * Nothing before there is somebody to do it for.
   *
   * The gate used to sit inside the Settings tab, so opening the panel dropped you
   * straight into Ask with no hint that an account existed — the corpus you were
   * looking at belonged to nobody, and none of it would sync anywhere. Guest counts
   * as somebody: choosing to work locally is a decision, not the absence of one.
   *
   * `accountReady` keeps this from flashing at a person who *is* signed in, which
   * is the most alarming thing a panel holding your notes can do on open.
   */
  if (!accountReady) return <div className="app" />;
  if (!account) {
    return (
      <div className="app">
        <header className="top">
          <strong>Autorag</strong>
        </header>
        <div className="pane">
          <section>
            <h2>
              Sign in <span className="soft">on the web app</span>
            </h2>
            <AccountGate
              account={null}
              onRecheck={recheckAccount}
              onGuest={() => {
                void ask({
                  kind: 'setAccount',
                  account: { email: '', guest: true, sessionId: PERSONAL },
                }).then(recheckAccount);
              }}
            />
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <h1>Autorag</h1>
        <div className="chips">
          <ModelStatus stats={stats} />
          <WebmcpStatus />
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'tab on' : 'tab'}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.badge ? <span className="pill">{t.badge}</span> : null}
          </button>
        ))}
      </nav>

      {/*
        All three panes stay mounted and the inactive ones are hidden, rather than
        rendered conditionally. Unmounting is what made switching tabs wipe the Ask
        pane — the question, the streamed answer and the whole remembered
        conversation went with the component. Scroll position in Library survives
        for the same reason.
      */}
      <div className={tab === 'ask' ? 'pane' : 'pane off'}>
        <Recall settings={settings} />
      </div>

      <div className={tab === 'library' ? 'pane' : 'pane off'}>
          <CurrentTab onCaptured={refresh} />
          <hr />
          <section>
            <h2>
              Waiting for you {pending.length > 0 && <span className="pill">{pending.length}</span>}
            </h2>
            {pending.length === 0 ? (
              <p className="empty">All clear. Highlight anything on any page to keep it.</p>
            ) : (
              pending.map((item) => <ReviewCard key={item.chunk_id} item={item} onDone={refresh} />)
            )}
          </section>
          <hr />
          <Corpus onChange={refresh} count={stats?.source_count} />
      </div>

      <div className={tab === 'settings' ? 'pane' : 'pane off'}>
        <AnswerSettings settings={settings} save={saveSettings} />
        <hr />
        <section>
          <h2>
            Account <span className="soft">created on the web app</span>
          </h2>
          <AccountGate account={account} onRecheck={recheckAccount} />
        </section>
        <hr />
        <Memory cloud={cloud} save={saveCloud} onSynced={refresh} />
        <hr />
        <PanelSessions cloud={cloud} save={saveCloud} account={account} onChanged={refresh} />
        <hr />
        <Activity />
      </div>

      {/*
        The footer carries the counts and the privacy line on every tab. Both are
        things you want to be able to glance at without navigating, and the second
        one is the most consequential sentence in the product — it must not be a
        tab you can forget to visit.
      */}
      <footer>
        {/* Sync is a background job with no surface of its own, so "did it work?"
            had no answer short of opening Supabase. */}
        {cloud.accessToken && <SyncStatus />}
        <span>
          {stats
            ? `${stats.approved} kept · ${stats.pending} to review · ${stats.source_count} sources`
            : 'reading corpus…'}
        </span>
        <span className={settings.apiKey ? 'leaves' : ''}>
          {settings.apiKey
            ? 'Kept on this machine · only answers leave it'
            : 'Kept on this machine · nothing is uploaded'}
        </span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
