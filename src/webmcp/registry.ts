/**
 * WebMCP registration layer.
 *
 * Two jobs:
 *  1. Find the model context object across the surfaces that exist in the wild
 *     (see lib/webmcp/API-DELTA.md D1).
 *  2. Manage tool lifetime with AbortController, since `unregisterTool` was
 *     removed from the spec in April 2026 (D2).
 */

import type { ModelContext, ModelContextTool } from '@mcp-b/webmcp-types';

/** Tool groups that come and go with app state, each with its own controller. */
export type ToolGroup = 'always' | 'approval' | 'retrieval';

type MaybeContext = ModelContext | undefined;

/**
 * D1: the spec and Chrome both use `document.modelContext`. We check `navigator`
 * too because older polyfill builds and much of the published documentation put
 * it there, and the cost of checking is one property access.
 */
export function getModelContext(): MaybeContext {
  if (typeof document === 'undefined') return undefined;
  const fromDocument = (document as unknown as { modelContext?: ModelContext }).modelContext;
  if (fromDocument) return fromDocument;
  const fromNavigator = (navigator as unknown as { modelContext?: ModelContext }).modelContext;
  return fromNavigator;
}

export function whichSurface(): 'document' | 'navigator' | 'none' {
  if (typeof document === 'undefined') return 'none';
  if ((document as unknown as { modelContext?: unknown }).modelContext) return 'document';
  if ((navigator as unknown as { modelContext?: unknown }).modelContext) return 'navigator';
  return 'none';
}

const controllers = new Map<ToolGroup, AbortController>();

/** Fires on every registration and every tool call, for the live ActivityLog. */
export type ActivityListener = (entry: ActivityEntry) => void;

export interface ActivityEntry {
  at: string;
  tool: string;
  phase: 'registered' | 'called' | 'returned' | 'failed';
  detail?: unknown;
}

const listeners = new Set<ActivityListener>();

export function onActivity(fn: ActivityListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(entry: ActivityEntry) {
  for (const fn of listeners) fn(entry);
}

/**
 * Registers a batch of tools under a group. Re-registering a group aborts the
 * previous one first, so React StrictMode's double-invoke and SPA navigation
 * cannot leave ghost tools behind.
 */
export async function registerGroup(
  group: ToolGroup,
  tools: ModelContextTool<never, unknown, string>[],
): Promise<boolean> {
  const ctx = getModelContext();
  if (!ctx) return false;

  abortGroup(group);
  const controller = new AbortController();
  controllers.set(group, controller);

  for (const tool of tools) {
    // Wrap execute so every agent call lands in the activity log. The log is a
    // demo surface: it makes the agent's work visible while it happens.
    const inner = tool.execute;
    const wrapped = {
      ...tool,
      execute: async (input: never) => {
        emit({ at: new Date().toISOString(), tool: tool.name, phase: 'called', detail: input });
        try {
          const result = await inner(input);
          emit({ at: new Date().toISOString(), tool: tool.name, phase: 'returned', detail: result });
          return toCallToolResult(result);
        } catch (err) {
          emit({ at: new Date().toISOString(), tool: tool.name, phase: 'failed', detail: String(err) });
          throw err;
        }
      },
    };
    try {
      await ctx.registerTool(wrapped as never, { signal: controller.signal });
    } catch (err) {
      // D13: `registerTool` rejects with AbortError if its signal fires while the
      // call is still pending — which is exactly what a re-registration of the
      // same group does, and what React StrictMode's double-invoked effect does on
      // every dev page load. The abort is the intended outcome, so swallow it;
      // rethrowing leaves an unhandled AbortError in the console of a page whose
      // whole pitch is that its lifecycle handling is careful.
      if (controller.signal.aborted) return false;
      throw err;
    }
    emit({ at: new Date().toISOString(), tool: tool.name, phase: 'registered' });
  }
  return true;
}

/** D2: this is what unregistration looks like now. */
export function abortGroup(group: ToolGroup): void {
  controllers.get(group)?.abort();
  controllers.delete(group);
}

export function abortAll(): void {
  for (const c of controllers.values()) c.abort();
  controllers.clear();
}

/**
 * D5: Chrome 149-153 hand back `inputSchema` as a serialized JSON string;
 * 154.0.8013+ returns an object. This machine runs 151, so the string arm is
 * the one that actually executes here.
 */
export function normalizeInputSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  if (typeof schema === 'object') return schema as Record<string, unknown>;
  if (typeof schema === 'string') {
    try {
      return JSON.parse(schema) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Wraps a tool's return value in an MCP `CallToolResult` envelope.
 *
 * **This is load-bearing, and its absence was invisible to direct testing.**
 *
 * `document.modelContext.executeTool()` serializes whatever a tool returns, so a
 * bare object round-trips fine when you call it yourself from page script. But an
 * agent does not do that — it connects through an MCP bridge (the MCP-B
 * extension, `@mcp-b/chrome-devtools-mcp`), and that bridge forwards **only**
 * results shaped as `{ content: [{ type: 'text', text }] }`. Anything else is
 * dropped and the agent receives an empty response.
 *
 * Measured on Chrome 151 through `call_webmcp_tool`:
 *
 *   returns a bare object      -> (no output)
 *   returns a plain string     -> (no output)
 *   returns an MCP envelope    -> {"ok":true,...}
 *
 * So every tool result is wrapped here, centrally, rather than trusting fifteen
 * tool bodies to remember. `structuredContent` carries the payload as data for
 * clients that read it; `content` carries the same thing as text for those that
 * do not.
 */
function toCallToolResult(value: unknown) {
  // Already an envelope (or an error the tool shaped itself): pass through.
  if (value && typeof value === 'object' && 'content' in (value as object)) {
    return value;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const result: Record<string, unknown> = { content: [{ type: 'text', text }] };
  if (value && typeof value === 'object') result.structuredContent = value;
  // Surface tool-level failures as MCP errors rather than silent successes.
  if (value && typeof value === 'object' && (value as { ok?: unknown }).ok === false) {
    result.isError = true;
  }
  return result;
}

/** D6: the spec defaults `title` to '', so `??` does not fall through. */
export function toolLabel(tool: { title?: string; name: string }): string {
  return tool.title || tool.name;
}
