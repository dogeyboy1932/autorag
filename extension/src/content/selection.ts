/**
 * Isolated world. Two jobs.
 *
 * 1. The human path: highlight text anywhere, a small button appears next to the
 *    selection, one click keeps it. No dashboard, no pasting a URL, no leaving
 *    the page. This is the whole usability argument — if keeping something costs
 *    more than a click, nobody keeps anything.
 *
 * 2. The bridge: the MAIN-world script has the WebMCP tools but no extension
 *    privileges, and the offscreen document has the corpus but no page access.
 *    This script is the only context that can talk to both.
 */

import {
  PAGE_REQUEST,
  PAGE_RESPONSE,
  PREVIEW_PAGE,
  PREVIEW_SELECTION,
  envelope,
  type Preview,
  type Request,
} from '../protocol';

/* ---------- 2. bridge: page tool calls -> service worker -> offscreen ---------- */

window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.type !== PAGE_REQUEST) return;

  let result: { ok: boolean; data?: unknown; error?: string };
  try {
    result = await chrome.runtime.sendMessage(envelope('worker', msg.request as Request));
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  window.postMessage({ type: PAGE_RESPONSE, id: msg.id, result }, window.location.origin);
});

/* ---------- 3. bridge out: make this tab visible to a desktop MCP client ---- */

/**
 * Injects the local relay's embed script into the page.
 *
 * This is the consuming half of WebMCP, and it is the piece that makes the tools
 * worth publishing. The embed opens a WebSocket to a relay process on loopback,
 * which any desktop MCP client can speak to over stdio — so the agent you already
 * use can call `autorag_recall` against the memory in this browser. No API key,
 * no cloud, no bespoke integration with us.
 *
 * It must be injected from here rather than from the MAIN world, because only an
 * isolated content script can resolve `chrome-extension://` URLs. And it must be
 * vendored rather than loaded from a CDN, because MV3 forbids the latter.
 *
 * Costs nothing when no relay is running: the embed simply never connects.
 */
function connectRelay() {
  /*
   * Only on http origins, and that is a hard limit rather than caution.
   *
   * The relay widget reaches the relay process over `ws://127.0.0.1`. From an
   * `https://` page the browser kills that socket during the handshake. Isolated
   * with everything else held identical — same relay, same extension, same MCP
   * client attached first, only the page origin different:
   *
   *   http://localhost:3901/   -> sources: 1
   *   https://example.com/     -> sources: 0, "WebSocket is closed before the
   *                               connection is established"
   *
   * Injecting it anyway would mean every https page you open silently
   * port-scans 9333-9348 and fails sixteen times. So: skip it where it cannot
   * work. See API-DELTA D16.
   */
  if (location.protocol !== 'http:') return;
  const el = document.createElement('script');
  el.src = chrome.runtime.getURL('relay/embed.js');
  el.dataset.autorag = 'relay';
  (document.head ?? document.documentElement).appendChild(el);
  el.remove(); // it has executed by now; do not leave furniture in the page
}
connectRelay();

/* ---------- 1. human path: the selection affordance ---------- */

const BUTTON_ID = 'autorag-keep-button';
let button: HTMLButtonElement | null = null;

function removeButton() {
  button?.remove();
  button = null;
}

function showButton(rect: DOMRect, text: string) {
  removeButton();
  button = document.createElement('button');
  button.id = BUTTON_ID;
  button.textContent = 'Keep';
  Object.assign(button.style, {
    position: 'absolute',
    // Above the selection, nudged left so the cursor is not covering it.
    top: `${window.scrollY + rect.top - 38}px`,
    left: `${window.scrollX + rect.left}px`,
    zIndex: '2147483647',
    padding: '6px 12px',
    font: '500 13px/1 ui-sans-serif, system-ui, sans-serif',
    color: '#fff',
    background: '#1f6feb',
    border: 'none',
    borderRadius: '6px',
    boxShadow: '0 2px 10px rgba(0,0,0,.28)',
    cursor: 'pointer',
  } satisfies Partial<CSSStyleDeclaration>);

  button.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection alive
  button.addEventListener('click', async () => {
    button!.textContent = 'Keeping…';
    button!.disabled = true;
    const res = await chrome.runtime.sendMessage(
      envelope('worker', {
        kind: 'ingest',
        text,
        sourceUrl: location.href,
        title: document.title || location.hostname,
      }),
    );
    if (!button) return;
    if (res?.ok) {
      const conflicts = (res.data as { conflicts?: unknown[] })?.conflicts ?? [];
      button.textContent = conflicts.length ? `Kept · ${conflicts.length} to review` : 'Kept';
      button.style.background = conflicts.length ? '#9e6a03' : '#1a7f37';
    } else {
      button.textContent = 'Failed';
      button.style.background = '#b62324';
      button.title = String(res?.error ?? 'unknown error');
    }
    setTimeout(removeButton, 1800);
  });


  document.body.appendChild(button);
}

document.addEventListener('selectionchange', () => {
  // Debounced by the mouseup below; selectionchange alone fires mid-drag.
});

document.addEventListener('mouseup', (event) => {
  if ((event.target as HTMLElement)?.id === BUTTON_ID) return;
  window.setTimeout(() => {
    const selection = window.getSelection();
    const text = (selection?.toString() ?? '').trim();
    if (text.length < 50 || !selection || selection.rangeCount === 0) {
      removeButton();
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    showButton(rect, text);
  }, 10);
});

document.addEventListener('mousedown', (event) => {
  if ((event.target as HTMLElement)?.id !== BUTTON_ID) removeButton();
});

/* ---------- shared capture path ---------- */

/** Brief confirmation at the corner, so a keystroke is not a silent no-op. */
function toast(message: string, tone: 'ok' | 'warn' | 'bad' = 'ok') {
  const el = document.createElement('div');
  el.textContent = message;
  Object.assign(el.style, {
    position: 'fixed',
    bottom: '18px',
    right: '18px',
    zIndex: '2147483647',
    padding: '9px 14px',
    font: '500 13px/1 ui-sans-serif, system-ui, sans-serif',
    color: '#fff',
    background: tone === 'ok' ? '#1a7f37' : tone === 'warn' ? '#9e6a03' : '#b62324',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0,0,0,.3)',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

async function keep(text: string, what: string) {
  if (text.trim().length < 50) {
    toast(`Nothing to keep — ${what} is under 50 characters.`, 'warn');
    return;
  }
  toast('Keeping…', 'warn');
  const res = await chrome.runtime.sendMessage(
    envelope('worker', {
      kind: 'ingest',
      text: text.trim(),
      sourceUrl: location.href,
      title: document.title || location.hostname,
    }),
  );
  if (res?.ok) {
    const n = (res.data as { conflicts?: unknown[] })?.conflicts?.length ?? 0;
    toast(n ? `Kept · ${n} conflict${n > 1 ? 's' : ''} to review` : 'Kept · awaiting your review');
  } else {
    toast(String(res?.error ?? 'Failed to keep'), 'bad');
  }
}

/**
 * Everything the page says *about* an image, gathered into a passage.
 *
 * Autorag indexes text — the embedding model is all-MiniLM-L6-v2, which has never
 * seen a pixel — so an image is kept the only way it can honestly be kept: by its
 * description, with the image URL as its provenance. That is a real limit and it is
 * better stated than disguised. An uncaptioned image genuinely cannot be found
 * later, and this returns null rather than storing a URL that no search will ever
 * match.
 *
 * Sources are checked nearest-first, because a figcaption is about *this* image
 * while the page title is about the whole article.
 */
function describeImage(img: HTMLImageElement): { text: string; title: string } | null {
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (label: string, value: string | null | undefined) => {
    const v = value?.trim().replace(/\s+/g, ' ');
    if (!v || v.length < 3 || seen.has(v.toLowerCase())) return;
    seen.add(v.toLowerCase());
    parts.push(`${label}: ${v}`);
  };

  add('Alt text', img.getAttribute('alt'));
  add('Caption', img.closest('figure')?.querySelector('figcaption')?.textContent);
  add('Title', img.getAttribute('title'));
  add('Link text', img.closest('a')?.getAttribute('aria-label'));

  /*
   * Everything above is *about this image*. Nothing below is, so nothing below may
   * be the only reason to keep it.
   *
   * Surrounding prose is enrichment and a decent tiebreaker, but on its own it
   * describes the page, not the picture — a 1px spacer in the body would inherit
   * the article's opening paragraphs and be stored as though someone had captioned
   * it. A check caught exactly that. So: a direct descriptor is required, and the
   * neighbourhood is only searched when the image sits in a container tighter than
   * the whole document.
   */
  const direct = parts.length;

  const nearby = img.closest('figure')?.parentElement ?? img.parentElement;
  const looseContainer =
    !nearby || nearby === document.body || nearby.tagName === 'MAIN' || nearby.tagName === 'ARTICLE';
  if (direct > 0 && !looseContainer) {
    const context = Array.from(nearby.querySelectorAll('p, h1, h2, h3, li'))
      .map((n) => n.textContent?.trim() ?? '')
      .filter((t) => t.length > 20)
      .slice(0, 2)
      .join(' ');
    add('Nearby text', context);
  }

  // A described image is worth keeping; a bare URL is not. The floor is a direct
  // descriptor, not the boilerplate appended below.
  if (direct === 0) return null;

  const title =
    img.getAttribute('alt')?.trim() ||
    img.closest('figure')?.querySelector('figcaption')?.textContent?.trim() ||
    `Image from ${document.title || location.hostname}`;

  parts.push(`Image URL: ${img.currentSrc || img.src}`);
  parts.push(`Seen on: ${document.title || location.hostname} — ${location.href}`);

  return { text: parts.join('\n'), title: title.slice(0, 120) };
}

/**
 * Keeps an image by what the page says about it. `srcUrl` comes from the context
 * menu, which reports the URL the person right-clicked.
 */
async function keepImage(srcUrl: string) {
  const img =
    Array.from(document.images).find((i) => i.currentSrc === srcUrl || i.src === srcUrl) ?? null;
  if (!img) {
    toast('Could not find that image on the page.', 'bad');
    return;
  }
  const described = describeImage(img);
  if (!described) {
    toast('This image has no caption or alt text — nothing to search on.', 'warn');
    return;
  }

  toast('Keeping the image description…', 'warn');
  const res = await chrome.runtime.sendMessage(
    envelope('worker', {
      kind: 'ingest',
      text: described.text,
      // The image is its own source, so keeping it twice from two pages
      // deduplicates, and recall hands back a URL that opens the picture itself.
      sourceUrl: img.currentSrc || img.src,
      title: described.title,
      tags: ['image', location.hostname.replace(/^www\./, '')],
    }),
  );
  if (res?.ok) {
    toast('Kept the description · add detail in the review queue');
  } else {
    toast(String(res?.error ?? 'Failed to keep the image'), 'bad');
  }
}

/**
 * The readable body of the page, for "keep what I am reading" when nothing is
 * highlighted. Deliberately crude — <article> or <main> if the page has one,
 * otherwise the body with the furniture stripped. A perfect extractor is a
 * different project; this only has to beat asking a person to select 2000 words.
 */
function readablePageText(): string {
  const root =
    document.querySelector('article') ??
    document.querySelector('main') ??
    document.querySelector('[role="main"]') ??
    document.body;
  const clone = root.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll('script,style,nav,header,footer,aside,noscript,form,button,svg')
    .forEach((n) => n.remove());
  return (clone.textContent ?? '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Context menu, keyboard shortcuts and the panel all land here.
 *
 * Capture and preview are split deliberately. The keystroke and the in-page Keep
 * button commit immediately, because they act on a selection you made on purpose
 * and a confirmation step would ruin the reflex. Whole-page capture goes through
 * a preview instead: it can be thousands of words, and nobody should hand that to
 * a memory sight-unseen.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'autorag:capture-image') {
    void keepImage(String(message.srcUrl ?? ''));
    return;
  }
  if (message?.type === 'autorag:capture-selection') {
    void keep(window.getSelection()?.toString() ?? '', 'your selection');
    return;
  }
  if (message?.type === 'autorag:capture-page') {
    void keep(readablePageText(), 'this page');
    return;
  }
  if (message?.type === PREVIEW_PAGE || message?.type === PREVIEW_SELECTION) {
    const text =
      message.type === PREVIEW_PAGE ? readablePageText() : (window.getSelection()?.toString() ?? '');
    sendResponse({
      text: text.trim(),
      title: document.title || location.hostname,
      url: location.href,
    } satisfies Preview);
    return true;
  }
});
