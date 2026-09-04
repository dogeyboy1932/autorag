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

/*
 * Imported as well as re-exported below: `export … from` forwards a name without
 * binding it locally, and the `ask` request in this very union refers to both.
 */
import type { AskSettings, AskTurn } from '@/src/rag/ask';

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
  /*
   * Identity: an email and a password against the directory. No Supabase project,
   * because joining someone else's session needs none — only hosting your own
   * corpus does. Requiring one here was what made sessions untestable.
   */
  | { kind: 'signIn'; email: string; password: string }
  | { kind: 'signUp'; email: string; password: string }
  /** A burner account for demo mode. No email, nothing to confirm. */
  | { kind: 'signInAnonymously' }
  | { kind: 'signOut' }
  /*
   * The web app handing its account to the extension.
   *
   * It only travels this direction. `externally_connectable` lets a page message
   * the extension, not the reverse, and the extension cannot reach into a tab that
   * may not be open — so the app pushes on every change rather than the panel
   * polling for something that might never appear.
   */
  | { kind: 'setAccount'; account: AccountState | null }
  | { kind: 'getAccount' }
  /*
   * Hosting: attach your own Supabase project. Separate password on purpose — it
   * authenticates to a different system, and making them match means changing one
   * silently breaks the other.
   */
  | { kind: 'attachProject'; url: string; anonKey: string; password: string; create: boolean; email?: string }
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

/**
 * Who is signed in, as the web app knows it.
 *
 * Identity is created in one place — the web app — and mirrored here so the panel
 * can show sessions without ever offering an account form of its own. That is what
 * makes being signed into two different accounts impossible rather than merely
 * discouraged.
 */
export interface AccountState {
  email: string;
  demo?: boolean;
  /**
   * Working without an account, on purpose.
   *
   * Stored rather than inferred from the absence of a directory session, because
   * "no account" and "chose to work locally" look identical from the outside and
   * mean opposite things: one is a person who has not decided yet, the other is a
   * decision. Reading the first as the second is what left the panel gated after
   * somebody had already answered it.
   */
  guest?: boolean;
  directory?: { accessToken: string; refreshToken: string; userId: string };
  sessionId?: string;
  host?: { url: string; anonKey: string; name: string };
}

/** Where a synced corpus lives. Stored in chrome.storage.local, like the API key. */
export interface CloudSettings {
  url: string;
  anonKey: string;
  accessToken?: string;
  refreshToken?: string;
  email?: string;
  /** This person's id in their *own* project — what RLS scopes their rows by. */
  userId?: string;
  /** Working without an account, on purpose. See `AccountState.guest`. */
  guest?: boolean;
  /**
   * True while this is a burner account made by Demo mode.
   *
   * Kept so the UI can say what it is rather than showing a random placeholder
   * address as though the person chose it, and so signing out can offer to
   * discard it instead of leaving an account nobody can ever sign back into.
   */
  demo?: boolean;
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

/**
 * Where the answering model lives and what it costs. Stored in chrome.storage.local.
 *
 * Defined in `src/rag/ask.ts` and re-exported here rather than declared twice. The
 * web app answers questions too now, and it has no business importing the
 * extension's message vocabulary to find out what Opus costs — but this file is
 * still the one place to read to learn everything the extension speaks, so the
 * names stay reachable from it.
 */
export {
  ASK_MODELS,
  DEFAULT_ASK_MODEL,
  type AskSettings,
  type AskTurn,
} from '@/src/rag/ask';

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
