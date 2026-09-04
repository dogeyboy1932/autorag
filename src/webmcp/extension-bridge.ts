/**
 * Talking to the extension from the web app, when it is installed.
 *
 * ## Why this needs an id at all
 *
 * `chrome.runtime.sendMessage` from a page requires the extension's id — there is
 * no "ask whoever is listening". The id is derived from the unpacked directory
 * path, so it is stable for anyone who unzips the download and loads it, which is
 * every user of this build. It is not a secret: it is visible on chrome://
 * extensions, and reaching this extension still requires being one of the origins
 * named in its `externally_connectable`.
 *
 * ## Why detection is a separate, cheap message
 *
 * `ping` is answered by the service worker without waking the offscreen document.
 * Every page load asks, and the offscreen document owns a 90MB embedding model —
 * loading it to answer "are you there" would make the site slow for the people who
 * have the extension, which is exactly backwards.
 *
 * ## Why absence is not an error
 *
 * Most visitors will not have it. Chrome answers a message to an extension that is
 * not installed by setting `runtime.lastError` and calling back with undefined, so
 * "not installed" arrives looking like a failure. It is a normal state, and the
 * page says so rather than reporting a fault.
 */

/**
 * Stable while the extension is loaded unpacked from a directory named
 * `extension/dist`, because Chrome derives an unpacked id from the path. Anyone
 * who unzips the download and loads the folder gets this id.
 */
export const EXTENSION_ID = 'obeilcdjggcekgfmiiadlcmfdhifajob';

type ChromeLike = {
  runtime?: {
    sendMessage?: (id: string, message: unknown, cb: (response: unknown) => void) => void;
    lastError?: { message?: string };
  };
};

const runtime = () => (globalThis as unknown as { chrome?: ChromeLike }).chrome?.runtime;

function send<T>(message: unknown, timeoutMs = 2000): Promise<T | null> {
  const rt = runtime();
  if (!rt?.sendMessage) return Promise.resolve(null);
  return new Promise<T | null>((resolve) => {
    /*
     * A timeout as well as the callback. If the extension is mid-restart the
     * callback can simply never fire, and a promise that never settles turns a
     * detection check into a page that renders nothing.
     */
    const timer = setTimeout(() => resolve(null), timeoutMs);
    try {
      rt.sendMessage!(EXTENSION_ID, message, (response) => {
        clearTimeout(timer);
        // Reading lastError is what tells Chrome the failure was handled; leaving
        // it unread logs "Unchecked runtime.lastError" on every page load.
        void rt.lastError;
        resolve((response as T) ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/** Is the extension installed and awake? Null-safe, and cheap enough to call on load. */
export async function extensionPresent(): Promise<{ version: string } | null> {
  const res = await send<{ ok?: boolean; version?: string }>({ type: 'autorag:ping' });
  return res?.ok ? { version: res.version ?? 'unknown' } : null;
}

/**
 * Runs one of the extension's own requests against its corpus.
 *
 * The envelope is the same one the panel uses, so this is not a second API with
 * its own drift — it is the existing one reached from a different origin.
 */
export async function askExtension<T>(request: unknown): Promise<T | null> {
  const res = await send<{ ok?: boolean; data?: T }>(
    { __autorag: true, to: 'worker', id: 'web', request },
    30_000,
  );
  return res?.ok ? ((res.data ?? null) as T) : null;
}
