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

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'autorag-keep',
    title: 'Keep this in Autorag',
    contexts: ['selection'],
  });
  void ensureOffscreen();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'autorag-keep' || !tab?.id) return;
  void chrome.tabs.sendMessage(tab.id, { type: 'autorag:capture-selection' });
});

// Clicking the toolbar icon opens the review panel beside whatever you are reading.
chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId });
});

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
