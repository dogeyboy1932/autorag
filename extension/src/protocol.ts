/**
 * The one message shape everything in the extension speaks.
 *
 * Four contexts need the corpus and none of them can share memory:
 *
 *   MAIN-world content script  — registers WebMCP tools on every page you visit,
 *                                but lives on the *page's* origin, so it cannot
 *                                touch extension storage at all
 *   isolated content script    — the selection affordance; can message the worker
 *   side panel                 — the review queue and search UI
 *   offscreen document         — owns IndexedDB and the embedding model
 *
 * So the offscreen document is the only place the corpus exists, and everyone
 * else asks it questions through the service worker. That indirection is not
 * ceremony: it is what lets a tool call originating on nytimes.com end up in the
 * same memory the side panel is showing.
 */

export type Request =
  | { kind: 'ingest'; text: string; sourceUrl: string; title: string; tags?: string[] }
  | { kind: 'dryRun'; text: string; sourceUrl: string }
  | { kind: 'search'; query: string; topK?: number; includeStale?: boolean }
  | { kind: 'answer'; question: string }
  | { kind: 'stats' }
  | { kind: 'listPending' }
  | { kind: 'revisePending'; chunkId: string; text?: string; note?: string }
  | {
      kind: 'adjudicate';
      chunkId: string;
      againstChunkId: string;
      ruling: 'keep_new' | 'keep_existing' | 'keep_both' | 'unresolved';
      reasoning: string;
    }
  | { kind: 'listSources' }
  | { kind: 'approve'; chunkIds: string[] }
  /** `reason` is optional: a person may discard without justifying it. */
  | { kind: 'reject'; chunkIds: string[]; reason?: string }
  | { kind: 'markStale'; sourceId: string; stale: boolean; reason?: string }
  | { kind: 'forget'; sourceId: string }
  | { kind: 'wipe' }
  | { kind: 'warmup' }
  | { kind: 'activity' }
  /**
   * Retrieve, then have a model write the answer from what was retrieved.
   *
   * The only request in this union that leaves the machine, and the only one that
   * costs money. Everything else — capture, embedding, screening, search — runs
   * locally and always will. Answering is the one job the corpus cannot do for
   * itself: it can find the passages, but composing prose out of them needs a
   * language model, and there is not one in the browser.
   *
   * `settings` travels with the request rather than being read from storage in the
   * offscreen document, so the key's path through the extension is visible in one
   * place instead of implicit.
   */
  | {
      kind: 'ask';
      question: string;
      settings: AskSettings;
      /**
       * Earlier turns, when Remember is on. Empty means every question is
       * independent — the default, because the failure mode of carrying context
       * is a quiet loss of citation integrity rather than an error.
       */
      history?: AskTurn[];
    }
  /**
   * Reconcile with the cloud: push what is here, pull what is not, apply
   * deletions both ways. Local storage stays the only thing anything reads from —
   * this mirrors, it does not relocate.
   */
  | { kind: 'sync'; cloud: CloudSettings }
  | { kind: 'cloudSignIn'; cloud: CloudSettings; email: string; password: string; create: boolean }
  /** Every session this person can reach: their own, invited, and open ones. */
  | { kind: 'listSessions'; cloud: CloudSettings }
  /** Publish a new shared session backed by this person's own project. */
  | { kind: 'createSession'; cloud: CloudSettings; name: string; openJoin?: boolean }
  /** Redeem a code: resolve whose project holds it and start mirroring it. */
  | { kind: 'joinSession'; cloud: CloudSettings; code: string }
  | { kind: 'inviteToSession'; cloud: CloudSettings; code: string; email: string }
  /** Move between sessions already reachable, including back to personal. */
  | { kind: 'switchSession'; cloud: CloudSettings; sessionId: string };

/** Where a synced corpus lives. Stored in chrome.storage.local, like the API key. */
export interface CloudSettings {
  url: string;
  anonKey: string;
  accessToken?: string;
  refreshToken?: string;
  email?: string;
  /** This person's id in their *own* project — what RLS scopes their rows by. */
  userId?: string;
  /**
   * The directory account: who this person is for the purpose of owning sessions
   * and receiving invites.
   *
   * Separate from the corpus sign-in above and necessarily so — auth users are
   * per-project, so the id here is unrelated to the one scoping their passages.
   * Both are obtained from one email and password, because being asked to hold
   * two accounts in your head is not a thing this feature is worth.
   */
  directory?: { accessToken: string; refreshToken: string; userId: string };
  /**
   * Whose project the active session actually lives in.
   *
   * Joining someone else's session means reading and writing *their* database, so
   * url and anonKey above are not enough on their own. Absent means the session is
   * this person's own and the credentials above apply.
   */
  host?: { url: string; anonKey: string; name: string };
  /**
   * The shared session being mirrored; absent means the private corpus.
   *
   * Everything between here and `syncNow` must carry this field. It was dropped
   * twice on the way — once by a destructure in the `sync` handler and once by a
   * hand-built config in `syncWithRenewal` — and the symptom was a sync that
   * reported pushing rows into a session while pushing none, because the engine
   * quietly fell back to the private scope. Explicit field lists are what made
   * that possible; if you add a field here, follow it to the call sites.
   */
  sessionId?: string;
}

/** Where the answering model lives and what it costs. Stored in chrome.storage.local. */
export interface AskSettings {
  apiKey: string;
  model: string;
}

export interface AskTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * The models the panel offers, with what they cost, because Ask is the first thing
 * in Autorag that spends money and a price nobody can see is a price nobody agreed to.
 */
export const ASK_MODELS = [
  /*
   * `adaptive` marks the models that take `thinking: {type:'adaptive'}` and
   * `output_config.effort`. Haiku 4.5 predates both: adaptive thinking is not a
   * mode it has, and `effort` is rejected outright. Sending them anyway made every
   * Haiku answer fail — a picker that offers a model and then speaks to it in a
   * dialect it does not understand.
   */
  { id: 'claude-opus-5', label: 'Opus 5', input: 5, output: 25, adaptive: true },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', input: 2, output: 10, adaptive: true },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', input: 1, output: 5, adaptive: false },
] as const;

export const DEFAULT_ASK_MODEL = 'claude-opus-5';

/** Panel ← offscreen, as the answer is written. */
export const ASK_DELTA = 'autorag:ask-delta';
export interface AskDelta {
  type: typeof ASK_DELTA;
  requestId: string;
  text?: string;
  done?: boolean;
  error?: string;
}

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/** Wrapper so the service worker can tell page traffic from offscreen replies. */
export interface Envelope {
  __autorag: true;
  to: 'worker' | 'offscreen';
  id: string;
  request: Request;
}

export function envelope(to: Envelope['to'], request: Request): Envelope {
  return { __autorag: true, to, id: Math.random().toString(36).slice(2), request };
}

export function isEnvelope(value: unknown): value is Envelope {
  return !!value && typeof value === 'object' && (value as Partial<Envelope>).__autorag === true;
}

/** Messages the MAIN world posts to the isolated world, and back. */
export const PAGE_REQUEST = 'autorag:page-request';
export const PAGE_RESPONSE = 'autorag:page-response';

/**
 * Marks a staged passage that a person still has to write. Only images use it: the
 * web mostly says nothing about its pictures, so an undescribed one is kept anyway
 * and the review queue refuses to approve it until this line is gone. Written by the
 * content script, read by the panel, and deliberately a visible English sentence —
 * it sits in the passage a person is editing, so it has to read like an instruction
 * rather than a token that leaked out of the code.
 */
export const NEEDS_DESCRIPTION = 'NEEDS A DESCRIPTION — say what this image shows, then keep it.';

/** Panel → content script: what *would* be captured, without capturing it. */
export const PREVIEW_PAGE = 'autorag:preview-page';
export const PREVIEW_SELECTION = 'autorag:preview-selection';

export interface Preview {
  text: string;
  title: string;
  url: string;
  /**
   * The tab is a PDF, so `text` being empty says nothing about the page.
   *
   * Chrome renders a PDF in a plugin whose text reaches no DOM the extension can
   * see — measured: `getSelection()` returns '' in every frame, including the
   * viewer's own, even with the whole document selected. Without this flag the
   * panel reads the empty string as "nothing is highlighted", which blames the
   * person for the one thing they definitely did.
   */
  isPdf?: boolean;
}

/** One line in the panel's activity feed. */
export interface Event {
  at: number;
  phase: 'working' | 'done' | 'failed';
  message: string;
}
