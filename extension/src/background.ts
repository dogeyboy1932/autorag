/**
 * Service worker: a router and nothing else.
 *
 * It deliberately holds no state. Chrome terminates it after ~30s idle, so
 * anything it remembered would evaporate at random; the corpus and the embedding
 * model live in the offscreen document, which does not.
 */

import { envelope, isEnvelope } from './protocol';

let creating: Promise<void> | null = null;

/** One offscreen document, created lazily and reused for the browser session. */
async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) return;
  if (creating) return creating;

  creating = chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification:
        'Runs the local embedding model and owns the IndexedDB corpus. Both need a document that outlives the service worker.',
    })
    .finally(() => {
      creating = null;
    });
  return creating;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isEnvelope(message) || message.to !== 'worker') return;

  (async () => {
    await ensureOffscreen();
    const reply = await chrome.runtime.sendMessage(envelope('offscreen', message.request));
    sendResponse(reply);
  })().catch((err: unknown) =>
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );

  return true; // async reply
});

/**
 * Manifest content scripts only reach tabs opened *after* the extension loads.
 *
 * Every tab already open when you install or reload it has no Autorag in it at all:
 * highlighting shows no Keep button, and the panel's preview asks a content script
 * that was never injected. The symptom is indistinguishable from a broken
 * extension, it happens to everyone exactly once — on the install, the moment they
 * are deciding whether this thing works — and the natural test is the tab they were
 * already reading. So do the injection Chrome does not.
 */
async function injectIntoOpenTabs(): Promise<void> {
  // `world` is real in MV3 but missing from @types/chrome's content-script shape.
  const declared = (chrome.runtime.getManifest().content_scripts ??
    []) as (chrome.runtime.ManifestV3['content_scripts'] extends (infer T)[] | undefined
    ? T & { world?: 'MAIN' | 'ISOLATED' }
    : never)[];
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (!tab.id) continue;
    for (const script of declared) {
      if (!script.js?.length) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: script.js,
          world: script.world === 'MAIN' ? 'MAIN' : 'ISOLATED',
        });
      } catch {
        // Expected on tabs no extension may touch — the web store, a page mid
        // navigation, a PDF viewer. Not worth a log line each; the others succeed.
      }
    }
  }
}

/**
 * Opens a PDF in Autorag's own reader.
 *
 * Chrome's PDF viewer renders through PDFium, whose text reaches no DOM — so a
 * highlight there is invisible to every extension, this one included. The reader
 * draws the PDF itself, which makes the selection ordinary DOM and every capture
 * path work unchanged. See `extension/src/reader/main.ts`.
 *
 * Opt-in per document, never automatic: Chrome's viewer stays the default, so
 * printing and form-filling still work where they always did.
 */
function openInReader(pdfUrl: string) {
  void chrome.tabs.create({
    url: chrome.runtime.getURL(`reader.html?src=${encodeURIComponent(pdfUrl)}`),
  });
}

/**
 * Delivers a message to whatever is running in a tab, content script or not.
 *
 * `chrome.tabs.sendMessage` reaches **content scripts only**. The PDF reader is an
 * extension page, so it never receives one, and every capture path was silently
 * dead there — the shortcut did nothing, and the panel concluded the tab had no
 * Autorag in it and told people to reload a page that was working perfectly.
 *
 * The obvious fix — check whether `tab.url` is the reader — does not work, and
 * failed in a way worth recording: **`tab.url` is `undefined` for the extension's
 * own pages unless the extension holds the `tabs` permission.** `<all_urls>` host
 * permission does not cover `chrome-extension://`, and `activeTab` only grants the
 * URL after a real user gesture, so the check passed or failed depending on how
 * the tab had been focused. Asking for `tabs` would fix it and cost an install-time
 * warning about reading your browsing history — a bad trade for a tool whose whole
 * claim is that nothing leaves the machine.
 *
 * So: try the content script, and fall back to a broadcast when nothing answers.
 * `tabId` rides along because a broadcast reaches *every* open reader and only the
 * one you are looking at should act; the reader compares it with
 * `chrome.tabs.getCurrent()`. No permission, no URL, no state to go stale.
 */
async function sendToTab(
  tab: chrome.tabs.Tab,
  message: { type: string; srcUrl?: string },
): Promise<unknown> {
  if (!tab.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    try {
      return await chrome.runtime.sendMessage({ ...message, tabId: tab.id });
    } catch {
      return null;
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'autorag-keep',
    title: 'Keep this in Autorag',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'autorag-keep-image',
    // Named for what it actually stores. Autorag indexes text, so an image is kept
    // by its caption, alt text and surrounding paragraph, with the image URL as
    // provenance — promising "keep this image" would promise search that cannot work.
    title: 'Keep this image’s description in Autorag',
    contexts: ['image'],
  });
  chrome.contextMenus.create({
    id: 'autorag-read-pdf',
    // Shown on links and on the page itself, because a PDF you are already
    // looking at is a page, while one you have not opened yet is a link.
    title: 'Read this PDF in Autorag',
    contexts: ['link', 'page'],
    targetUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*'],
    documentUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*'],
  });
  void ensureOffscreen();
  void injectIntoOpenTabs();
});

// Reloading an unpacked extension during development fires onStartup, not
// onInstalled, and leaves every open tab in the same scriptless state.
chrome.runtime.onStartup.addListener(() => {
  void injectIntoOpenTabs();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'autorag-read-pdf') {
    const url = info.linkUrl ?? info.pageUrl;
    if (url) openInReader(url);
    return;
  }
  if (!tab?.id) return;
  if (info.menuItemId === 'autorag-keep') {
    void sendToTab(tab, { type: 'autorag:capture-selection' });
  }
  if (info.menuItemId === 'autorag-keep-image' && info.srcUrl) {
    void chrome.tabs.sendMessage(tab.id, {
      type: 'autorag:capture-image',
      srcUrl: info.srcUrl,
    });
  }
});

/*
 * Keyboard is the point of a standby tool. Reaching for a button is already more
 * friction than most things are worth; a keystroke while you are still reading is
 * not. Both shortcuts act on the tab you are looking at — nothing is ever typed,
 * pasted or addressed by URL.
 */
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (command === 'keep-selection') {
    void sendToTab(tab, { type: 'autorag:capture-selection' });
  }
  if (command === 'keep-page') {
    void sendToTab(tab, { type: 'autorag:capture-page' });
  }
});

/*
 * The in-page offer on a Chrome-rendered PDF. The content script cannot open an
 * extension page itself, so it asks here.
 */
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'autorag:open-reader' && message.url) openInReader(String(message.url));
});

/** Panel → the tab you are looking at. Used for both preview and capture. */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'autorag:to-active-tab') return;
  (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return sendResponse(null);
    // Null still means "nothing in this tab answered" — a chrome:// page, the
    // store, or a tab that predates the extension. The reader now answers.
    sendResponse(await sendToTab(tab, { type: message.what }));
  })();
  return true;
});

/**
 * What the page is exposing to agents right now.
 *
 * Read straight out of the page's own MAIN world rather than from anything we
 * remember, because the question the panel is answering is "is WebMCP actually
 * live on this tab" and only the page can answer that honestly.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'autorag:webmcp-status') return;
  (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return sendResponse(null);
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: async () => {
          const ctx = (
            document as unknown as {
              modelContext?: { getTools(): Promise<{ name: string; description?: string }[]> };
            }
          ).modelContext;
          // The scheme comes from inside the page because `tab.url` is undefined
          // for the extension's own pages without the `tabs` permission — which is
          // exactly the case the panel most needs to name.
          const scheme = location.protocol;
          if (!ctx?.getTools) return { present: false, tools: [], scheme };
          const tools = await ctx.getTools();
          return {
            present: true,
            scheme,
            tools: tools.map((t) => ({ name: t.name, description: t.description ?? '' })),
          };
        },
      });
      sendResponse(result ?? null);
    } catch {
      sendResponse(null);
    }
  })();
  return true;
});

// Clicking the toolbar icon opens the review panel beside whatever you are reading.
chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId });
});

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/**
 * Storage, on behalf of the offscreen document.
 *
 * An offscreen document is given `chrome.runtime` and very little else —
 * `chrome.storage` is undefined there. Every read and write the offscreen
 * document made was therefore throwing "Cannot read properties of undefined
 * (reading 'local')", and because the only caller that mattered was a
 * fire-and-forget `void autoSync()`, the rejection went nowhere: automatic sync
 * had never once run, and reported nothing while not running.
 *
 * The service worker does have storage, so it does the reading. Kept as two
 * dumb verbs rather than a typed API because the offscreen document already owns
 * the meaning of what is stored; this end only needs to fetch and merge.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'autorag:storage-get' && message?.type !== 'autorag:storage-set') return;
  (async () => {
    if (message.type === 'autorag:storage-get') {
      sendResponse(await chrome.storage.local.get(message.key));
      return;
    }
    // Merge rather than replace: callers patch one field of `cloud` and would
    // otherwise silently drop the tokens sitting beside it.
    const key = Object.keys(message.patch ?? {})[0];
    if (key) {
      const current = (await chrome.storage.local.get(key)) as Record<string, unknown>;
      const value = message.patch[key];
      const merged =
        value && typeof value === 'object' && !Array.isArray(value)
          ? { ...((current[key] as object) ?? {}), ...value }
          : value;
      await chrome.storage.local.set({ [key]: merged });
    }
    sendResponse({ ok: true });
  })();
  return true;
});

/**
 * The web app, talking to the extension.
 *
 * `externally_connectable` in the manifest names the two origins allowed to reach
 * this — the deployed site and localhost during development — and Chrome refuses
 * every other sender before this listener runs. That allowlist is the whole of the
 * security boundary here, which is why it names exact origins rather than a
 * pattern that could match a subdomain someone else controls.
 *
 * What it enables: the site can tell whether the extension is installed, and can
 * work on the same corpus instead of its own. Without it the two surfaces are
 * strangers holding separate IndexedDBs, and someone who installs the extension
 * after using the site watches their passages apparently vanish.
 *
 * `ping` is answered separately and deliberately cheaply. Detection is the common
 * case — every page load asks — and it must not wake the offscreen document, which
 * would mean loading a 90MB embedding model to answer "are you there".
 */
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'autorag:ping') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return true;
  }
  if (!isEnvelope(message) || message.to !== 'worker') return;

  (async () => {
    await ensureOffscreen();
    sendResponse(await chrome.runtime.sendMessage(envelope('offscreen', message.request)));
  })();
  return true;
});
