/**
 * Talking to the extension from the web app.
 *
 * ## Why not `chrome.runtime.sendMessage(EXTENSION_ID, …)`
 *
 * That is the documented way, and it was the first thing here, and it was silently
 * broken for anybody who was not me. It needs the extension's id — and an unpacked
 * extension's id is derived from the *directory it was loaded from*. The id
 * compiled into this file matched one machine's checkout. Load the same build from
 * a downloaded zip, or any other folder, and every message goes to an extension
 * that does not exist: sign-in never arrives, sign-out never arrives, and the
 * panel's Check again reads an empty box. No error, because a message to a missing
 * extension is not an error.
 *
 * ## What this does instead
 *
 * `window.postMessage`, answered by the content script the extension already
 * injects into every page — this one included. That script *is* the extension, so
 * it needs no id, no `externally_connectable` entry, and no knowledge of where it
 * was installed from. If it is not there, nothing answers, and the timeout below
 * is the whole of "no extension installed".
 *
 * The bridge accepts memory-tool calls from any page on purpose; the account
 * messages it carries are restricted to Autorag's own origins, enforced in the
 * content script where a page cannot reach.
 */

import { PAGE_REQUEST, PAGE_RESPONSE } from '@/extension/src/protocol';

let seq = 0;

function call<T>(request: unknown, timeoutMs: number): Promise<T | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);

  return new Promise<T | null>((resolve) => {
    const id = `web-${++seq}-${Date.now()}`;
    let settled = false;

    const done = (value: T | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(value);
    };

    function onMessage(event: MessageEvent) {
      if (event.source !== window) return;
      const data = event.data as { type?: string; id?: string; result?: { ok?: boolean; data?: T } };
      if (data?.type !== PAGE_RESPONSE || data.id !== id) return;
      done(data.result?.ok ? ((data.result.data ?? null) as T) : null);
    }

    window.addEventListener('message', onMessage);
    /*
     * The timeout is not an error path, it is the answer. Most visitors have no
     * extension, so nothing replies, and a promise that never settles would hang
     * whatever awaited it.
     */
    const timer = setTimeout(() => done(null), timeoutMs);
    window.postMessage({ type: PAGE_REQUEST, id, request }, window.location.origin);
  });
}

/** Is the extension present? Cheap enough to call on every page load. */
export async function extensionPresent(): Promise<{ version: string } | null> {
  const res = await call<{ model_ready?: boolean }>({ kind: 'stats' }, 1500);
  return res ? { version: 'installed' } : null;
}

/**
 * Runs one of the extension's own requests against its corpus.
 *
 * The same envelope the panel uses, so this is not a second API with its own
 * drift — it is the existing one reached from a page.
 */
export async function askExtension<T>(request: unknown): Promise<T | null> {
  return await call<T>(request, 30_000);
}
