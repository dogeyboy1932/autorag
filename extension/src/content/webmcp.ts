/**
 * MAIN world. Runs on every page you visit.
 *
 * **This is the part that is not "an LLM with a vector database".**
 *
 * A vector database sits behind an API that something has to be integrated with.
 * These four tools are registered on `document.modelContext` of whatever page you
 * happen to be reading, so any WebMCP-aware agent driving your browser — Chrome's
 * own, a coding agent over an MCP bridge, anything that speaks the standard —
 * discovers your curated memory *on the page it is already looking at*, with no
 * integration, no endpoint, no key.
 *
 * The agent does not know Autorag exists. It sees `autorag_remember_selection`
 * next to whatever tools the site itself offers, and can move what it is reading
 * into your memory, or consult that memory about what it is reading.
 *
 * This script owns no data. It cannot: it runs on the page's origin, not the
 * extension's. Every tool is a proxy that posts a message to the isolated-world
 * script, which reaches the offscreen document where the corpus actually lives.
 *
 * Importing `@mcp-b/global` first is what makes this work at all. Ordinary sites
 * do not register a `document.modelContext`, and most browsers do not supply one
 * without a flag — measured: `undefined` on wikipedia.org. The polyfill installs
 * the standard surface on whatever page you are reading, so the tools below have
 * somewhere to live. The extension is not only adding tools; it is bringing
 * WebMCP to pages that have never heard of it.
 */

import '@mcp-b/global';
import { PAGE_REQUEST, PAGE_RESPONSE, type Request } from '../protocol';

const pending = new Map<string, (r: { ok: boolean; data?: unknown; error?: string }) => void>();

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.type !== PAGE_RESPONSE || !pending.has(msg.id)) return;
  pending.get(msg.id)!(msg.result);
  pending.delete(msg.id);
});

function ask(request: Request): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    pending.set(id, resolve);
    window.postMessage({ type: PAGE_REQUEST, id, request }, window.location.origin);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ ok: false, error: 'Autorag did not respond. Is the extension still enabled?' });
      }
    }, 30_000);
  });
}

/** D12: MCP bridges forward only this envelope. Anything else arrives empty. */
function toCallToolResult(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const result: Record<string, unknown> = { content: [{ type: 'text', text }] };
  if (value && typeof value === 'object') result.structuredContent = value;
  if (value && typeof value === 'object' && (value as { ok?: unknown }).ok === false) {
    result.isError = true;
  }
  return result;
}

async function proxy(request: Request) {
  const r = await ask(request);
  return toCallToolResult(
    r.ok ? { ok: true, ...(r.data as object) } : { ok: false, error: { message: r.error } },
  );
}

/** What the user currently has highlighted, plus where they are. */
function selectionText(): string {
  return (window.getSelection()?.toString() ?? '').trim();
}

const tools = [
  {
    name: 'autorag_remember_selection',
    description:
      "Save the text the person currently has highlighted on this page into their Autorag memory. Use this when they say to remember, save or keep what they are looking at, without asking them to paste it — the selection is already known. The passage is staged for their review and does not become searchable until they approve it, so say it is awaiting review rather than implying it is saved. Returns an error naming autorag_remember_passage if nothing is selected.",
    inputSchema: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description:
            'Optional one-line reason this is worth keeping, shown to the person when they review it.',
        },
      },
    },
    annotations: { readOnlyHint: false },
    execute: async (input: { note?: string }) => {
      const text = selectionText();
      if (text.length < 50) {
        return toCallToolResult({
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message:
              text.length === 0
                ? 'Nothing is selected on this page. Ask the person to highlight the passage, or send the text yourself with autorag_remember_passage.'
                : `Only ${text.length} characters are selected; at least 50 are needed. Ask them to widen the selection, or send the text with autorag_remember_passage.`,
            suggested_next_tool: 'autorag_remember_passage',
          },
        });
      }
      return proxy({
        kind: 'ingest',
        text,
        sourceUrl: location.href,
        title: document.title || location.hostname,
        tags: input?.note ? [input.note] : undefined,
      });
    },
  },
  {
    name: 'autorag_remember_passage',
    description:
      'Save a passage you have read on this page into the person\'s Autorag memory, when nothing is highlighted or you want to keep only part of what is on screen. Send the meaningful body text only, with navigation, ads and cookie banners stripped. Staged for their review; not searchable until they approve it.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The passage to keep, as plain text. Between 50 and 20000 characters.',
        },
        title: {
          type: 'string',
          description:
            "Human-readable title for the source, shown to the person reviewing it. Defaults to this page's title.",
        },
      },
      required: ['text'],
    },
    annotations: { readOnlyHint: false },
    execute: (input: { text: string; title?: string }) =>
      proxy({
        kind: 'ingest',
        text: input.text,
        sourceUrl: location.href,
        title: input.title || document.title || location.hostname,
      }),
  },
  {
    name: 'autorag_recall',
    description:
      "Search everything the person has previously chosen to keep, from any site, and get back passages with the URL and date each came from. Their memory is not limited to this page — use this before answering from your own knowledge on any topic they may have read about. Returns passages plus match signals; you decide whether they answer the question.",
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'What you want to know, in the words you would use to ask a person. Full questions work better than keywords.',
        },
      },
      required: ['question'],
    },
    annotations: { readOnlyHint: true },
    execute: (input: { question: string }) => proxy({ kind: 'answer', question: input.question }),
  },
  {
    name: 'autorag_memory_stats',
    description:
      'How much the person has kept: passages approved, awaiting review, and rejected, plus how many sources and whether the embedding model has finished loading. Cheap orientation call before deciding whether autorag_recall is worth making.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: () => proxy({ kind: 'stats' }),
  },
];

async function register() {
  // The polyfill installs itself on import, but defers to a native surface when
  // the browser already has one, so this reads whichever is in play.
  const ctx = (document as unknown as { modelContext?: { registerTool(t: unknown): Promise<void> } })
    .modelContext;
  if (!ctx?.registerTool) return;

  for (const tool of tools) {
    try {
      await ctx.registerTool(tool);
    } catch (err) {
      /*
       * Never swallow this. An empty catch here cost a debugging cycle: one tool
       * silently failed to register and the surface simply came up one short,
       * with nothing anywhere saying why. A registration that fails is a bug in
       * our schema every time — duplicates included, since a duplicate means we
       * ran twice on one document.
       */
      console.error(`[autorag] failed to register ${tool.name}:`, err);
    }
  }
}

void register();
