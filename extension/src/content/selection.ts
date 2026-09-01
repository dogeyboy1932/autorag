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

import { PAGE_REQUEST, PAGE_RESPONSE, envelope, type Request } from '../protocol';

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

/** Context menu and keyboard shortcuts all land here, sharing one code path. */
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'autorag:capture-selection') {
    void keep(window.getSelection()?.toString() ?? '', 'your selection');
  }
  if (message?.type === 'autorag:capture-page') {
    void keep(readablePageText(), 'this page');
  }
});
