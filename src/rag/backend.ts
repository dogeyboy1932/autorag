/**
 * Every request to Autorag's Supabase project goes through here, so that one
 * failure — the project being paused or unreachable — reads as what it is.
 *
 * ## Why this needs saying at all
 *
 * A free-tier Supabase project pauses itself after a quiet week. Nothing in the
 * app is broken when that happens, but every request fails in a way that looks
 * like it is: the browser reports `TypeError: Failed to fetch` (a paused project
 * answers without CORS headers, so the page never sees the response), or the
 * gateway answers 540/503 with a body nobody using Autorag should have to read.
 * Sign-in says "Failed to fetch", sync says "HTTP 540", and the person concludes
 * their memory is gone.
 *
 * It is not: passages live in IndexedDB on the device and only *mirror* to the
 * project. So the message says that — what still works, what does not, and that
 * nothing was lost.
 */

export const BACKEND_UNAVAILABLE =
  'Autorag’s server is unreachable right now — its database is probably paused. Nothing is ' +
  'lost: everything you have kept is still in this browser, and keeping, search and Ask keep ' +
  'working. Signing in, sessions and sync will resume once the server is back.';

/** Thrown for a paused or unreachable project, so callers can tell it from a refusal. */
export class BackendUnavailableError extends Error {
  constructor() {
    super(BACKEND_UNAVAILABLE);
    this.name = 'BackendUnavailableError';
  }
}

/*
 * 540 is Supabase's own status for a paused project; 502–504 are what a gateway
 * returns while one is paused or restoring. A 500 is left alone — that is the
 * database answering with an error, which is worth seeing as itself.
 */
const PAUSED_STATUSES = new Set([502, 503, 504, 540]);

/**
 * `fetch`, except that a paused or unreachable project becomes
 * `BackendUnavailableError` instead of a bare network error or gateway page.
 * Every other response — including 4xx refusals — is returned untouched for the
 * caller to report as before.
 */
export async function backendFetch(input: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (err) {
    // An abort is the caller's decision, not an outage.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new BackendUnavailableError();
  }
  if (PAUSED_STATUSES.has(res.status)) throw new BackendUnavailableError();
  return res;
}
