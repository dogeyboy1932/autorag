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
  NEEDS_DESCRIPTION,
  PAGE_REQUEST,
  PAGE_RESPONSE,
  PREVIEW_PAGE,
  PREVIEW_SELECTION,
  envelope,
  type Preview,
  type Request,
} from '../protocol';
import { isPdfTab, keep, tabTitle, toast, watchSelection } from './keep-ui';

/*
 * The highlight → Keep affordance lives in `keep-ui.ts` because the PDF reader
 * needs the same one on an extension page, where content scripts do not run.
 * Here it keeps its default source: the page this script was injected into.
 */
watchSelection();

/* ---------- 2. bridge: page tool calls -> service worker -> offscreen ---------- */

/**
 * Requests that carry or reveal who is signed in, which only Autorag's own pages
 * may make.
 *
 * Everything else on this bridge is a memory tool: an agent on any page is meant
 * to be able to call them, which is the entire point of publishing them. These two
 * are different — one hands over an account, the other reads it back — so they are
 * limited to the origins that own the account in the first place.
 *
 * Checked against the *page's* origin here in the isolated world, where a page
 * cannot reach in and change it.
 */
const ACCOUNT_KINDS = new Set(['setAccount', 'getAccount']);
const APP_ORIGINS = ['https://autorag-web.netlify.app', 'http://localhost:3111'];

window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.type !== PAGE_REQUEST) return;

  const kind = (msg.request as { kind?: string } | undefined)?.kind;
  if (kind && ACCOUNT_KINDS.has(kind) && !APP_ORIGINS.includes(location.origin)) {
    window.postMessage(
      { type: PAGE_RESPONSE, id: msg.id, result: { ok: false, error: 'not an Autorag origin' } },
      window.location.origin,
    );
    return;
  }

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
function describeImage(
  img: HTMLImageElement,
): { text: string; title: string; described: boolean } {
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
   * pass itself off as a description.
   *
   * Surrounding prose is enrichment and a decent tiebreaker, but on its own it
   * describes the page, not the picture — a 1px spacer in the body would inherit
   * the article's opening paragraphs and be stored as though someone had captioned
   * it. A check caught exactly that. So it is only gathered when the image already
   * has a direct descriptor and sits in a container tighter than the whole document.
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

  /*
   * Most images on the web say nothing about themselves. Refusing those was the
   * first design and it was wrong: it refused exactly the ones worth keeping —
   * screenshots, charts, diagrams — while a decorative logo with a dutiful alt
   * attribute sailed through. Whether an image matters is a judgement, and this
   * product already has somewhere judgements go.
   *
   * So an undescribed image is staged carrying NEEDS_DESCRIPTION, and the review
   * queue shows it with the picture and refuses to let it be kept until a person
   * has written what it is. Same bargain as every other capture — nothing enters
   * the memory unexamined — rather than a machine deciding on your behalf that a
   * picture was not worth the trouble.
   */
  const title =
    img.getAttribute('alt')?.trim() ||
    img.closest('figure')?.querySelector('figcaption')?.textContent?.trim() ||
    `Image from ${document.title || location.hostname}`;

  if (direct === 0) {
    parts.push(NEEDS_DESCRIPTION);
    parts.push('Nothing on the page said what this image shows.');
  }

  /*
   * Provenance goes in metadata, never in the indexed text.
   *
   * These two lines used to append the image URL and the page URL to the passage
   * itself, which meant embedding them. On an ordinary article that is mild; on a
   * search-results page it is fatal — a Brave image CDN URL is ~250 characters of
   * base64, several times the length of the actual caption, so the vector was
   * mostly hash and BM25 got a pile of tokens that match nothing a person would
   * ever type. The card cheerfully reported "22 words", almost none of them words.
   *
   * The image URL is already the chunk's `sourceUrl`, so it survives as the
   * citation and as the thumbnail. The page it was seen on moves to a tag. What
   * stays in the text is the page *title*, which is the one part with retrieval
   * value: "the diagram from the page about adaptive thinking" is a real query.
   */
  const seenOn = document.title || location.hostname;
  if (seenOn) parts.push(`Seen on: ${seenOn}`);

  return { text: parts.join('\n'), title: title.slice(0, 120), described: direct > 0 };
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
  toast('Keeping…', 'warn');
  const res = await chrome.runtime.sendMessage(
    envelope('worker', {
      kind: 'ingest',
      text: described.text,
      // The image is its own source, so keeping it twice from two pages
      // deduplicates, and recall hands back a URL that opens the picture itself.
      sourceUrl: img.currentSrc || img.src,
      title: described.title,
      tags: [
        'image',
        ...(described.described ? [] : ['needs-description']),
        location.hostname.replace(/^www\./, ''),
        // Where it was seen, kept out of the indexed text — see describeImage().
        `page:${location.href}`,
      ],
    }),
  );
  if (res?.ok) {
    toast(
      described.described
        ? 'Kept the description · awaiting your review'
        : 'Kept · the page said nothing about it, so describe it in the review panel',
      described.described ? 'ok' : 'warn',
    );
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
      title: tabTitle(),
      url: location.href,
      isPdf: isPdfTab(),
    } satisfies Preview);
    return true;
  }
});
