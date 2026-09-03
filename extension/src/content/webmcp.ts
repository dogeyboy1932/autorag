/**
 * MAIN world. Runs on every page you visit.
 *
 * **This is the part that is not "an LLM with a vector database".**
 *
 * A vector database sits behind an API that something has to be integrated with.
 * These seven tools are registered on `document.modelContext` of whatever page you
 * happen to be reading, so any WebMCP-aware agent driving your browser — Chrome's
 * own, a coding agent over an MCP bridge, anything that speaks the standard —
 * discovers your curated memory *on the page it is already looking at*, with no
 * integration, no endpoint, no key.
 *
 * Three of the seven exist to keep the curation loop whole: an agent can read the
 * review queue and rule on a flagged pair, so screening's deliberate over-flagging
 * is triaged before it reaches a person. It cannot approve or discard — those two
 * verbs are deliberately absent from this surface, and live only in the side panel
 * where the person is. Nominate, adjudicate, decide: the third belongs to a human.
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

/**
 * `listKey` names the array a list request answers with. Without it, spreading an
 * array into the result object turns it into `{"0": …, "1": …}` — valid JSON that
 * an agent cannot page or count. Only list requests need it.
 */
async function proxy(request: Request, listKey?: string) {
  const r = await ask(request);
  if (!r.ok) return toCallToolResult({ ok: false, error: { message: r.error } });
  const data = Array.isArray(r.data)
    ? { [listKey ?? 'items']: r.data, total_count: r.data.length }
    : (r.data as object);
  return toCallToolResult({ ok: true, ...data });
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
    name: 'autorag_list_pending',
    description:
      "List the passages the person has kept but not yet reviewed, with anything screening flagged about them. Nothing here is searchable yet. Use it to see what you or they have captured this session, and to find flagged pairs worth ruling on with autorag_adjudicate_conflict. Each flagged pair carries both passages, so you can read the claims rather than trust the flag. You cannot approve or discard: that is the person's decision, made in the Autorag side panel.",
    inputSchema: {
      type: 'object',
      properties: {
        only_conflicted: {
          type: 'boolean',
          description:
            'When true, return only passages screening flagged. Use this when your intent is to adjudicate rather than to survey.',
        },
      },
    },
    annotations: { readOnlyHint: true },
    execute: async (input: { only_conflicted?: boolean }) => {
      const r = await proxy({ kind: 'listPending' }, 'pending');
      if (!input?.only_conflicted) return r;
      const body = r.structuredContent as
        | { ok?: boolean; pending?: { conflicts: unknown[] }[] }
        | undefined;
      if (!body?.ok || !body.pending) return r;
      const flagged = body.pending.filter((p) => p.conflicts.length > 0);
      return toCallToolResult({ ok: true, pending: flagged, total_count: flagged.length });
    },
  },
  {
    name: 'autorag_adjudicate_conflict',
    description:
      'Rule on a pair of passages that screening flagged. Screening only nominates: it can see that two passages are about the same subject and carry different figures, never whether they actually disagree. Read both — autorag_list_pending returns each flagged passage alongside the one it collides with — and record a verdict. Your verdict is advisory. It is shown to the person in their review queue and approves nothing; ruling keep_both does not keep anything, it says the two do not conflict.',
    inputSchema: {
      type: 'object',
      properties: {
        chunk_id: {
          type: 'string',
          description: 'The staged passage that was flagged, from autorag_list_pending.',
        },
        against_chunk_id: {
          type: 'string',
          description:
            "The passage it was flagged against — the conflict entry's against_chunk_id.",
        },
        ruling: {
          type: 'string',
          enum: ['keep_new', 'keep_existing', 'keep_both', 'unresolved'],
          description:
            'keep_new: the flagged passage supersedes the older one. keep_existing: the older one is still correct. keep_both: they do not actually conflict. unresolved: the text alone does not settle it.',
        },
        reasoning: {
          type: 'string',
          description:
            'One or two sentences the person will read while deciding. Name the specific claims that do or do not conflict — not the similarity score.',
        },
      },
      required: ['chunk_id', 'against_chunk_id', 'ruling', 'reasoning'],
    },
    annotations: { readOnlyHint: false },
    execute: (input: {
      chunk_id: string;
      against_chunk_id: string;
      ruling: 'keep_new' | 'keep_existing' | 'keep_both' | 'unresolved';
      reasoning: string;
    }) => {
      if (!input?.reasoning?.trim()) {
        return toCallToolResult({
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message:
              'reasoning is required — it is the whole point of the ruling. The person reads it instead of comparing the two passages themselves.',
          },
        });
      }
      return proxy({
        kind: 'adjudicate',
        chunkId: input.chunk_id,
        againstChunkId: input.against_chunk_id,
        ruling: input.ruling,
        reasoning: input.reasoning.trim(),
      });
    },
  },
  {
    name: 'autorag_list_sources',
    description:
      'List the pages the person has kept material from, with how many passages of each are approved, awaiting review or discarded, and whether a source has been marked out of date. Use it to see what their memory actually covers before searching it, and to avoid re-capturing a page that is already in there.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: () => proxy({ kind: 'listSources' }, 'sources'),
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

/**
 * True on a page that publishes its own `autorag_*` tools — the Autorag web app.
 *
 * Both surfaces use the same tool names over *different* corpora: the app's
 * lives in that page's IndexedDB, ours in the extension's offscreen document.
 * Registering on top of it is wrong twice over. It throws `Tool already
 * registered` for whichever ran second, and even if the names were disjoint it
 * would hand an agent two memories under one roof with no way to tell which
 * answered.
 *
 * The `<meta>` is in the served HTML, so it is there whichever script wins the
 * race — the app registers from a React effect, we run at `document_idle`, and
 * the order is not ours to decide. `getTools()` is the backstop for a build
 * without the tag; it only helps when we lose the race, which is why it is not
 * the primary check.
 */
async function pageOwnsSurface(ctx: { getTools?(): Promise<{ name?: string }[]> }) {
  if (document.querySelector('meta[name="autorag-owns-modelcontext"]')) return true;
  if (!ctx.getTools) return false;
  try {
    return (await ctx.getTools()).some((t) => t?.name?.startsWith('autorag_'));
  } catch {
    return false;
  }
}

async function register() {
  // The polyfill installs itself on import, but defers to a native surface when
  // the browser already has one, so this reads whichever is in play.
  const ctx = (
    document as unknown as {
      modelContext?: {
        registerTool(t: unknown): Promise<void>;
        getTools?(): Promise<{ name?: string }[]>;
      };
    }
  ).modelContext;
  if (!ctx?.registerTool) return;

  if (await pageOwnsSurface(ctx)) return;

  for (const tool of tools) {
    try {
      await ctx.registerTool(tool);
    } catch (err) {
      /*
       * Never swallow this. An empty catch here cost a debugging cycle: one tool
       * silently failed to register and the surface simply came up one short,
       * with nothing anywhere saying why. A registration that fails is a bug in
       * our schema every time — a duplicate now means either we ran twice on one
       * document or something else on the page claimed an `autorag_` name.
       */
      console.error(`[autorag] failed to register ${tool.name}:`, err);
    }
  }
}

void register();
