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

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'autorag-keep',
    title: 'Keep this in Autorag',
    contexts: ['selection'],
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
  if (info.menuItemId !== 'autorag-keep' || !tab?.id) return;
  void chrome.tabs.sendMessage(tab.id, { type: 'autorag:capture-selection' });
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
    void chrome.tabs.sendMessage(tab.id, { type: 'autorag:capture-selection' });
  }
  if (command === 'keep-page') {
    void chrome.tabs.sendMessage(tab.id, { type: 'autorag:capture-page' });
  }
});

/** Panel → the tab you are looking at. Used for both preview and capture. */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'autorag:to-active-tab') return;
  (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return sendResponse(null);
    try {
      sendResponse(await chrome.tabs.sendMessage(tab.id, { type: message.what }));
    } catch {
      // No content script on this tab — chrome:// pages, the store, a PDF viewer.
      sendResponse(null);
    }
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
          const ctx = (document as unknown as { modelContext?: { getTools(): Promise<{ name: string }[]> } })
            .modelContext;
          if (!ctx?.getTools) return { present: false, tools: [] };
          return { present: true, tools: (await ctx.getTools()).map((t) => t.name) };
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
