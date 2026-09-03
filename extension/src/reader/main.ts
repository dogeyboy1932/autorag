/**
 * Autorag's PDF reader — the answer to "why can't I highlight in a PDF?"
 *
 * **The measurement that forced this.** Chrome hands a PDF to PDFium, a C++
 * renderer that draws glyphs to a canvas. With an entire document selected,
 * `getSelection()` returns `''` in the top frame, in every intermediate frame,
 * and inside the viewer's own `chrome-extension://mhjfbmdgcf…/index.html` — read
 * over CDP, which is more access than an extension is ever granted. The text is
 * not in any DOM, so this is not a permissions problem and no manifest key
 * fixes it. Extracting the PDF's bytes ourselves would recover the *words* and
 * still never recover the *selection*, which is the thing being asked for.
 *
 * So Autorag renders the PDF itself. Once it does, the text layer is ordinary
 * DOM: highlighting works, `keep-ui.ts` works unchanged, and there is no PDF
 * special case anywhere in the capture path. That is the whole design — not a
 * PDF feature, but the removal of a PDF exception.
 *
 * Opt-in per document: Chrome's viewer stays the default and nothing is
 * hijacked, so printing, signing and form-filling still work where they did.
 */

import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { PREVIEW_PAGE, PREVIEW_SELECTION, type Preview } from '../protocol';
import { keep, setSource, toast, watchSelection } from '../content/keep-ui';

/*
 * Every one of these is resolved by PDF.js at runtime from a URL we supply, and
 * MV3 forbids the CDN defaults. Getting one wrong does not throw — the reader
 * comes up and quietly renders a blank page, or tofu, for the documents that
 * needed it. `pnpm ext:check` opens a real PDF for exactly this reason.
 */
const asset = (path: string) => chrome.runtime.getURL(`pdfjs/${path}`);
pdfjs.GlobalWorkerOptions.workerSrc = asset('pdf.worker.mjs');

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const viewer = el<HTMLDivElement>('viewer');
const statusBox = el<HTMLDivElement>('status');

/** A visible sentence beats a blank page. Every failure below lands here. */
function fail(heading: string, detail: string, showOriginal = true) {
  viewer.hidden = true;
  statusBox.hidden = false;
  statusBox.innerHTML = '';
  const h = document.createElement('h2');
  h.textContent = heading;
  const p = document.createElement('p');
  p.textContent = detail;
  statusBox.append(h, p);
  if (showOriginal && src) {
    const a = document.createElement('a');
    a.href = src;
    a.textContent = "Open it in Chrome's viewer instead";
    statusBox.append(a);
  }
}

const src = new URL(location.href).searchParams.get('src') ?? '';

/**
 * What a passage kept here will cite.
 *
 * A PDF has no `document.title` (measured: the empty string), so the filename is
 * the only thing on hand that tells one paper from another. Without this the
 * source would be `chrome-extension://…/reader.html`, which is worse than
 * useless as a citation — it would make every PDF passage look like it came from
 * the extension rather than from the document you were reading.
 */
function pdfName(): string {
  try {
    const file = decodeURIComponent(new URL(src).pathname.split('/').pop() ?? '');
    return file || new URL(src).hostname;
  } catch {
    return src || 'PDF';
  }
}

/* ------------------------------------------------------------------ rendering */

let doc: PDFDocumentProxy | null = null;
let scale = 1.35;
/** Pages already drawn, so a scroll back up does not redraw what is still there. */
const drawn = new Set<number>();

/**
 * Draws one page: a canvas for the pixels, a text layer above it for the words.
 *
 * The text layer is the entire point. It is a stack of transparent, absolutely
 * positioned spans holding the real characters, aligned over the drawn glyphs by
 * the vendored `pdf_viewer.css`. Selecting across it is an ordinary DOM
 * selection, which is why `keep-ui.ts` needs no knowledge that this is a PDF.
 */
async function renderPage(page: PDFPageProxy, host: HTMLDivElement) {
  const viewport = page.getViewport({ scale });
  host.style.width = `${Math.floor(viewport.width)}px`;
  host.style.height = `${Math.floor(viewport.height)}px`;
  if (drawn.has(page.pageNumber)) return;
  drawn.add(page.pageNumber);
  host.classList.remove('placeholder');

  const canvas = document.createElement('canvas');
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  host.append(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  await page.render({ canvas, canvasContext: ctx, viewport, transform: [ratio, 0, 0, ratio, 0, 0] })
    .promise;

  const layer = document.createElement('div');
  layer.className = 'textLayer';
  host.append(layer);
  await new pdfjs.TextLayer({
    textContentSource: page.streamTextContent(),
    container: layer,
    viewport,
  }).render();
}

/**
 * Pages are drawn as they come into view, not all at once.
 *
 * A hundred-page paper rendered eagerly is a hung tab and several hundred
 * megabytes of bitmap. Each page gets its correctly sized box up front so the
 * scrollbar is honest from the start, and fills in shortly before it is reached.
 */
async function open() {
  if (!src) {
    return fail(
      'No PDF given',
      'This page opens a PDF that Autorag can read text out of. Open a PDF and choose "Read in Autorag" from the side panel or the right-click menu.',
      false,
    );
  }

  el<HTMLSpanElement>('name').textContent = pdfName();
  const original = el<HTMLAnchorElement>('original');
  original.href = src;

  let bytes: ArrayBuffer;
  try {
    // `host_permissions: <all_urls>` covers the fetch; `credentials: 'include'`
    // is what lets a PDF behind a session cookie load at all.
    const res = await fetch(src, { credentials: 'include' });
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    bytes = await res.arrayBuffer();
  } catch (err) {
    return fail(
      'Could not fetch that PDF',
      src.startsWith('file:')
        ? 'It is a local file. Chrome hides those from extensions until you turn on "Allow access to file URLs" for Autorag on chrome://extensions.'
        : `${err instanceof Error ? err.message : String(err)}. The document may need a login, or the site may refuse to serve it to an extension.`,
    );
  }

  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      cMapUrl: asset('cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: asset('standard_fonts/'),
      wasmUrl: asset('wasm/'),
      iccUrl: asset('iccs/'),
    }).promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(
      /password/i.test(message) ? 'That PDF is password protected' : 'Could not read that PDF',
      /password/i.test(message)
        ? 'Autorag cannot open encrypted documents.'
        : `${message}. It may be damaged, or not actually a PDF.`,
    );
  }

  el<HTMLSpanElement>('pages').textContent = `${doc.numPages} page${doc.numPages > 1 ? 's' : ''}`;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const host = entry.target as HTMLDivElement;
        const n = Number(host.dataset.page);
        void doc?.getPage(n).then((page) => renderPage(page, host));
      }
    },
    // Start a page early so it is drawn by the time it is scrolled to.
    { root: null, rootMargin: '800px 0px' },
  );

  // Size every page box first, from page 1's viewport, so the scrollbar does not
  // lurch as pages fill in. Sizes are corrected exactly when each page renders.
  const first = await doc.getPage(1);
  const guess = first.getViewport({ scale });
  for (let n = 1; n <= doc.numPages; n++) {
    const host = document.createElement('div');
    host.className = 'page placeholder';
    host.dataset.page = String(n);
    host.style.width = `${Math.floor(guess.width)}px`;
    host.style.height = `${Math.floor(guess.height)}px`;
    viewer.append(host);
    observer.observe(host);
  }
  viewer.style.setProperty('--scale-factor', String(scale));

  await noticeIfScanned();
}

/**
 * A scanned PDF is a stack of photographs. There is no text layer to select,
 * and saying so is the difference between a limitation and a broken reader.
 */
async function noticeIfScanned() {
  if (!doc) return;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  if (content.items.length > 0) return;
  toast(
    'This PDF has no text layer — it is scanned images. Nothing here can be selected; that needs OCR.',
    'warn',
  );
}

/** Re-render at a new zoom. Text layers are rebuilt so selection stays aligned. */
async function zoom(by: number) {
  if (!doc) return;
  scale = Math.min(4, Math.max(0.5, Math.round((scale + by) * 20) / 20));
  viewer.style.setProperty('--scale-factor', String(scale));
  drawn.clear();
  for (const host of Array.from(viewer.children) as HTMLDivElement[]) {
    host.innerHTML = '';
    host.classList.add('placeholder');
    const page = await doc.getPage(Number(host.dataset.page));
    const v = page.getViewport({ scale });
    host.style.width = `${Math.floor(v.width)}px`;
    host.style.height = `${Math.floor(v.height)}px`;
  }
  // The observer still holds every page; those in view redraw on the next tick.
  window.dispatchEvent(new Event('scroll'));
  for (const host of Array.from(viewer.children) as HTMLDivElement[]) {
    const box = host.getBoundingClientRect();
    if (box.bottom < -800 || box.top > window.innerHeight + 800) continue;
    void doc.getPage(Number(host.dataset.page)).then((page) => renderPage(page, host));
  }
}

el<HTMLButtonElement>('in').addEventListener('click', () => void zoom(0.2));
el<HTMLButtonElement>('out').addEventListener('click', () => void zoom(-0.2));

/* -------------------------------------------------------------------- capture */

setSource(() => ({ url: src, title: pdfName() }));
watchSelection();

/*
 * `chrome.commands` is delivered to the background, which forwards keep-selection
 * with `chrome.tabs.sendMessage` — and that reaches **content scripts only**. An
 * extension page in a tab never receives it, so the background broadcasts to us
 * with `chrome.runtime.sendMessage` instead and this is the other end. Without
 * it the shortcut is silently dead in the one place it most needs to work.
 */
/**
 * This reader's own tab id, so a broadcast meant for the tab you are looking at
 * is not answered by a second reader open in another tab.
 */
let myTabId: number | undefined;
void chrome.tabs.getCurrent().then((t) => {
  myTabId = t?.id;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (typeof message?.tabId === 'number' && message.tabId !== myTabId) return;
  if (message?.type === 'autorag:capture-selection') {
    const text = (window.getSelection()?.toString() ?? '').trim();
    if (!text) {
      toast('Nothing is highlighted.', 'warn');
      return;
    }
    void keep(text, 'your selection');
    return;
  }

  /*
   * Whole-document capture. Read out of pdf.js rather than off the screen,
   * because the reader only draws pages as you scroll to them — scraping the DOM
   * would silently return the two or three pages that happen to be rendered and
   * look like it had captured the paper.
   */
  if (message?.type === 'autorag:capture-page') {
    void documentText().then((text) => keep(text, 'this PDF'));
    return;
  }
  if (message?.type === PREVIEW_PAGE || message?.type === PREVIEW_SELECTION) {
    const wanted =
      message.type === PREVIEW_PAGE
        ? documentText()
        : Promise.resolve((window.getSelection()?.toString() ?? '').trim());
    void wanted.then((text) =>
      sendResponse({ text, title: pdfName(), url: src } satisfies Preview),
    );
    return true;
  }
});

/**
 * Every word in the PDF, in reading order, page by page.
 *
 * `hasEOL` is what turns pdf.js's stream of positioned runs back into lines.
 * Without it a paper arrives as one unbroken paragraph, which reads badly and
 * chunks worse.
 */
async function documentText(): Promise<string> {
  if (!doc) return '';
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    let out = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      out += item.str + (item.hasEOL ? '\n' : '');
    }
    pages.push(out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
  }
  return pages.filter(Boolean).join('\n\n');
}

void open();
