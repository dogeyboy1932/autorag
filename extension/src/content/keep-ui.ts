/**
 * The capture affordance: highlight something, a Keep button appears, one click
 * stores it. Plus the toast that tells you what happened.
 *
 * This lives apart from `selection.ts` because it now has two homes, and only one
 * of them is a content script:
 *
 *  - **Any web page**, injected as a content script (`selection.ts`).
 *  - **The PDF reader** (`../reader/main.ts`), which is an extension page. Chrome
 *    renders PDFs with PDFium, whose text reaches no DOM — measured:
 *    `getSelection()` returns '' even inside the viewer's own frame, over CDP.
 *    So Autorag renders the PDF itself, and once it does, the selection is
 *    ordinary DOM and this module works there unchanged.
 *
 * Nothing else from `selection.ts` may come along: it also injects the relay embed
 * and sits beside the MAIN-world WebMCP script, and neither belongs on a
 * `chrome-extension://` origin (API-DELTA D17).
 *
 * **The one thing that differs between the two homes is what to call the source.**
 * On a page it is `location.href`. In the reader `location.href` is
 * `chrome-extension://…/reader.html?src=…`, which would be useless as a citation
 * and would make every PDF passage look like it came from the extension. So the
 * source is injectable, and defaults to the page.
 */

import { envelope } from '../protocol';

export interface SourceIdentity {
  url: string;
  title: string;
}

/** Overridden by the reader; every other caller wants the page it is running on. */
let sourceOf: () => SourceIdentity = () => ({ url: location.href, title: tabTitle() });

/**
 * Points capture at something other than the current document.
 *
 * Call before `watchSelection()`. The reader passes the PDF's real URL and its
 * filename, so a passage kept from a paper cites the paper.
 */
export function setSource(fn: () => SourceIdentity): void {
  sourceOf = fn;
}

/**
 * The one action available on a Chrome-rendered PDF: reopen it in Autorag's
 * reader, where the text is real DOM and highlighting works normally.
 *
 * A clickable toast rather than the usual one, which sets `pointer-events: none`
 * so it never eats a click meant for the page. Here the click is the whole point.
 */
function offerReader() {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'fixed',
    bottom: '18px',
    right: '18px',
    zIndex: '2147483647',
    maxWidth: '340px',
    padding: '12px 14px',
    font: '500 13px/1.45 ui-sans-serif, system-ui, sans-serif',
    color: '#fff',
    background: '#1f2937',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0,0,0,.35)',
  } satisfies Partial<CSSStyleDeclaration>);

  const line = document.createElement('div');
  line.textContent =
    "Chrome draws PDFs in a viewer no extension can read, so your highlight never reaches Autorag.";
  const button = document.createElement('button');
  button.textContent = 'Open it in Autorag’s reader';
  Object.assign(button.style, {
    marginTop: '9px',
    padding: '6px 11px',
    font: '600 13px/1 ui-sans-serif, system-ui, sans-serif',
    color: '#fff',
    background: '#1f6feb',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  } satisfies Partial<CSSStyleDeclaration>);
  button.addEventListener('click', () => {
    void chrome.runtime.sendMessage({ type: 'autorag:open-reader', url: location.href });
    el.remove();
  });

  el.append(line, button);
  document.body.appendChild(el);
  // Longer than an ordinary toast: this one asks you to decide something.
  setTimeout(() => el.remove(), 9000);
}

/** Brief confirmation at the corner, so a keystroke is not a silent no-op. */
export function toast(message: string, tone: 'ok' | 'warn' | 'bad' = 'ok') {
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

/**
 * True on a tab the browser is rendering as a PDF.
 *
 * `document.contentType` rather than a `.pdf` URL test: it is exact, and it is
 * right for a PDF served from a path that does not end in `.pdf`, which the URL
 * heuristic misses. Measured on Chrome 152 — a PDF served at `/report` reports
 * `application/pdf` here while the URL says nothing.
 */
export function isPdfTab(): boolean {
  return document.contentType === 'application/pdf';
}

/**
 * What to call this tab in the review queue and the source list.
 *
 * A PDF has no `document.title` — measured: the empty string — so the usual
 * hostname fallback labels every PDF you ever keep "localhost" or "arxiv.org".
 * The filename is the only thing on hand that distinguishes one paper from
 * another, so a PDF is named by it.
 */
export function tabTitle(): string {
  if (document.title) return document.title;
  if (isPdfTab()) {
    const file = decodeURIComponent(location.pathname.split('/').pop() ?? '');
    if (file) return file;
  }
  return location.hostname;
}

export async function keep(text: string, what: string) {
  /*
   * A PDF has to be caught before the length check, because on a PDF the length
   * is always zero and it is never the reason.
   *
   * Chrome hands a PDF to a plugin, and the text it draws lives in no DOM the
   * extension can reach: with the entire document selected, `getSelection()`
   * returns '' in the top frame, in the viewer's own `chrome-extension://`
   * frame, and in every frame between. So "your selection is under 50
   * characters" was true and useless — it told someone who had just highlighted
   * three paragraphs that they had highlighted nothing, and sent them back to
   * highlight harder.
   */
  if (isPdfTab() && text.trim().length === 0) {
    /*
     * A door, not a wall. Naming the cause and stopping there was the first
     * version, and it left people staring at a correct sentence with nothing to
     * do about it — the same dead end as the message it replaced, just honest
     * about why. Autorag *can* read this PDF; it only has to draw it first.
     */
    offerReader();
    return;
  }
  if (text.trim().length < 50) {
    toast(`Nothing to keep — ${what} is under 50 characters.`, 'warn');
    return;
  }
  toast('Keeping…', 'warn');
  const res = await chrome.runtime.sendMessage(
    envelope('worker', {
      kind: 'ingest',
      text: text.trim(),
      ...asIngest(),
    }),
  );
  if (res?.ok) {
    const n = (res.data as { conflicts?: unknown[] })?.conflicts?.length ?? 0;
    toast(n ? `Kept · ${n} conflict${n > 1 ? 's' : ''} to review` : 'Kept · awaiting your review');
  } else {
    toast(String(res?.error ?? 'Failed to keep'), 'bad');
  }
}
/** The source fields every ingest carries, from whichever identity is installed. */
function asIngest(): { sourceUrl: string; title: string } {
  const { url, title } = sourceOf();
  return { sourceUrl: url, title };
}

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
      envelope('worker', { kind: 'ingest', text, ...asIngest() }),
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

/**
 * Installs the highlight → Keep affordance on this document.
 *
 * Separate from module load because the reader must call `setSource()` first,
 * and because an extension page has no content-script lifecycle to hang it on.
 */
export function watchSelection(): void {
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
}
