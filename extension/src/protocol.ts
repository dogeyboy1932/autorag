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
  | { kind: 'activity' };

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
}

/** One line in the panel's activity feed. */
export interface Event {
  at: number;
  phase: 'working' | 'done' | 'failed';
  message: string;
}
