# API-DELTA — what the WebMCP surface actually looks like

**Established 2026-08-31.** Every claim below marked ✓ was **verified by running it**
against Chrome 151 in headless Puppeteer, not read off a doc page. Sources: the
[W3C spec](https://webmachinelearning.github.io/webmcp/),
[Chrome's imperative API docs](https://developer.chrome.com/docs/ai/webmcp/imperative-api),
and — most authoritative — the shipped TypeScript definitions in
`@mcp-b/webmcp-types@5.1.0`, read directly out of `node_modules`.

Where docs and shipped types disagree, **the types win**. They did disagree.

---

## D1. The global is `document.modelContext`

Not `navigator.modelContext`. The spec, Chrome's docs, and `@mcp-b/global`'s own
package description all agree. `navigator.modelContext` is the older polyfill-era
name that still dominates blog posts and npm READMEs — including the one quoted in
`webmcp-devtools-takeaways.md` §2, which is what created the ambiguity.

✓ **Verified.** Native Chrome 151 exposes **both** `document.modelContext` and
`navigator.modelContext` as objects — `navigator` is not dead, just secondary. The
Chrome binary also carries the literal string
`document.modelContext cannot be used when document.domain is enabled.`, which settles
which surface is canonical.

We feature-detect both in `src/webmcp/registry.ts`, preferring `document`.

### Enabling native WebMCP

The `chrome://flags/#enable-webmcp-testing` entry exists in Chrome 151, but the
command-line switch `--enable-webmcp-testing` does **not** work. What works:

```bash
google-chrome-stable --enable-features=WebMCP        # or --enable-blink-features=WebMCP
```

Verified across five flag variants; only these two produce a `modelContext`.

## D2. Removed APIs — do not use

| API | Status |
|---|---|
| `provideContext()` | Removed, March 2026 spec revision |
| `clearContext()` | Removed, March 2026 spec revision |
| `unregisterTool()` | Removed, April 2026, replaced by `AbortSignal` |

Unregistration is now: pass `{ signal }` at registration, call `controller.abort()`.

✓ **Verified on native.** Registered one tool (`getTools()` → 1), called
`controller.abort()`, `getTools()` → 0. This is what drives our dynamic
register/unregister (approval tools appear only when the pending queue is non-empty).

## D3. `execute` takes ONE argument

```ts
execute: (input: TArgs) => MaybePromise<TResult>;
```

Chrome's docs show `execute: async ({ layer, action }, { signal }) => {...}` — a
second options argument carrying an `AbortSignal`. **The shipped types do not have it,
and neither does the runtime.**

✓ **Verified on both surfaces.** A tool declared `execute: (...args) => ...` and
invoked through `ctx.executeTool()` observed:

| | native Chrome 151 | `@mcp-b/global` 5.1.0 |
|---|---|---|
| `args.length` | **1** | **1** |
| `typeof args[1]` | `undefined` | `undefined` |

Write every tool against the one-argument form. Chrome's published docs are wrong here.

## D4. `requestUserInteraction` is not reachable

It appears in no IDL in the spec, and there is no agent/client object in the `execute`
signature that could carry it. Blog posts describing `agent.requestUserInteraction()`
are describing something not present in this type surface.

✓ **Verified absent on native Chrome 151 and on the polyfill.** There is no second
argument at all, so there is nothing that could carry it. This is settled — stop
looking for it.

**Consequence:** the human approval gate is **in-page only** (`components/ReviewQueue.tsx`).
Ingest tools stage and return "awaiting human approval"; the agent polls
`autorag_list_pending`. Per `amendments.md` A1 the queue is *steering*, not a security
control, so nothing is lost. Re-probe at runtime before the final build in case Chrome
exposes it non-normatively.

## D5. `inputSchema` is split across Chrome versions — webmcp#241

```ts
inputSchema?: InputSchema | string;
```

- Chrome **149–153** (most of the Origin Trial population, **including this machine's
  Chrome 151**): returns a **serialized JSON string**.
- Chrome **154.0.8013+**: returns a **JSON Schema object**, cross-document tools first.

✓ **Verified — and the two runtimes genuinely disagree:**

| Runtime | `typeof registeredTool.inputSchema` |
|---|---|
| native Chrome 151 | **`string`** (serialized JSON) |
| `@mcp-b/global` 5.1.0 | **`object`** |

So the polyfill silently papers over the difference and native does not. Code that
works in dev (polyfill) can break for a grader (native). `normalizeInputSchema()` in
`src/webmcp/registry.ts` handles both arms; use it everywhere and never touch
`inputSchema` directly.

## D6. Two smaller gotchas

- ✓ **`title` defaults to the empty string.** Confirmed on both runtimes: a tool
  registered with no `title` reads back as `""`, so `tool.title ?? tool.name` does
  *not* fall through. Always `tool.title || tool.name` — `toolLabel()` does this.
- **`annotations` may be absent entirely** per the spec. Both runtimes here happened
  to emit `{readOnlyHint, untrustedContentHint}` in full, but do not rely on it —
  never write `tool.annotations.readOnlyHint` unguarded.

## D7. MCP-B runtime extensions are non-standard

`@mcp-b/global` adds `outputSchema` on tools and a synchronous `listTools()`.
Native Chrome has neither. We **do not depend on either** — the submission must work
on a plain flag-enabled Chrome. Treat them as dev-loop conveniences only.

## D8. Environment (this machine)

| Thing | Value |
|---|---|
| Chrome | 151.0.7922.173 — past the 149 minimum, so native WebMCP works behind `chrome://flags/#enable-webmcp-testing` |
| Node / pnpm | 24.2.0 / 10.12.1 |
| `@mcp-b/global` | 5.1.0 |
| MCP-B extension | installed (`daohopfhkdelnpemnhlekblhnikhdhfa`) — dev loop only, never a submission dependency |

## D9. `@mcp-b/chrome-devtools-mcp@latest` is broken — pin 2.3.2

`3.0.0` publishes a tarball of **3 files (43 KB)**: its `package.json` declares
`files: ["build/src"]` but no `build/` directory is in the tarball, so both declared
bins point at nonexistent paths. `npx` fails with `chrome-devtools-mcp: not found`.

`2.3.2` is the last good release (281 files, 59 MB). The command in
`webmcp-devtools-takeaways.md` §1 must therefore be:

```bash
claude mcp add chrome-devtools -- npx -y @mcp-b/chrome-devtools-mcp@2.3.2 --isolated
```


---

## D10. The declarative form API has validation rules, extracted from the binary

Chrome 151 ships DevTools issue descriptions for the declarative `<form>` API. Their
names tell us exactly what it validates, which is otherwise undocumented:

- `FormModelContextMissingToolName` — the form needs `toolname`
- `FormModelContextMissingToolDescription` — and `tooldescription`
- `FormModelContextParameterMissingName` — every field needs a `name`
- `FormModelContextParameterMissingTitleAndDescription` — every field needs a title
  **and** a description, not one or the other
- `FormModelContextRequiredParameterMissingName` — required fields especially

Build the Phase 4 declarative form to satisfy all five, and check the DevTools Issues
panel for these exact strings.

The binary also contains `kDeclarativeWebmcp` and `devtools-webmcp-support`
(“Enables WebMCP support in DevTools”), so there is a DevTools panel worth turning on
while building.

---

## Phase 0 gate: PASSED (2026-08-31)

| Check | Result |
|---|---|
| `modelContext` surface found | ✓ `document` (and `navigator`) |
| `registerTool` round-trip | ✓ |
| Tool visible via `getTools()` | ✓ |
| Agent-style invoke via `executeTool()` | ✓ returned `{"ok":true,"echo":"hi"}` |
| `AbortController` unregistration | ✓ 1 tool → abort → 0 tools |
| Works on native Chrome 151 | ✓ |
| Works on `@mcp-b/global` polyfill | ✓ |
| Round-trip through an MCP bridge (`call_webmcp_tool`) | ✓ *(only after D12)* |

Not yet done, and still owed from build plan §6 Phase 0: the transformers.js model
download from a deployed origin.

**ChatGPT's in-app browser is explicitly out of scope** (decided 2026-08-31). We
verify against flag-enabled Chrome 151 only, and the README says so rather than
implying coverage we have not tested.

---

## D11. Aborting a group kills its own in-flight tool call

Found while building the dynamic registration in Phase 2, and not documented anywhere.

The spec says `controller.abort()` unregisters "without breaking in-flight
executions". In Chrome 151 that is **not** what happens when the executing tool
belongs to the group being aborted. The pending `executeTool` promise rejects with:

```
UnknownError: The operation failed for an unknown transient reason (e.g. out of memory).
```

Concretely: `autorag_approve_pending` empties the review queue, which retracts the
`approval` group — the group containing `autorag_approve_pending` itself. The
approval *commits to IndexedDB*, and then the agent receives an opaque
`DOMException` instead of the success payload. An agent that retries then gets
`NOT_FOUND`, because the work already succeeded. That is the worst possible error
shape: silent success reported as an unrecoverable failure.

**The rule this imposes:** never retract a tool group from inside a tool call.

`src/webmcp/lifecycle.ts` splits the two directions accordingly —
`syncToolGroups()` only ever *adds* and is awaited by mutating tools so an agent
told to poll a tool finds it already registered; `sweepRetired()` only ever
*removes* and runs from a React effect, after the call that changed the state has
returned. Verified: approve now returns
`{"ok":true,"approved_chunk_ids":[...],"message":"Approved 1 chunk(s)..."}`.

---

## D12. MCP bridges forward ONLY an MCP `CallToolResult` envelope

**The most consequential finding in this file, and it was invisible to direct testing
for an entire build.**

`document.modelContext.executeTool()` serializes whatever a tool returns, so a bare
object round-trips perfectly when page script calls it. Every test written against that
path passed.

But an agent never uses that path. It connects through an MCP bridge — the MCP-B Chrome
extension, or `@mcp-b/chrome-devtools-mcp` — and **the bridge forwards only results
shaped as an MCP `CallToolResult`.** Everything else is silently dropped: no error, no
warning, just an empty response.

Measured on Chrome 151 via `call_webmcp_tool`, three tools differing only in return
shape:

| `execute` returns | Result through the MCP bridge |
|---|---|
| `{ ok: true, shape: 'bare-object' }` | *(no output)* |
| `'{"ok":true,...}'` (plain string) | *(no output)* |
| `{ content: [{ type:'text', text }] }` | `{"ok":true,"shape":"mcp-envelope"}` |

Autorag returned bare objects. So for most of this build **all 15 tools returned
nothing to any agent connecting over MCP**, while every Puppeteer test passed and the
UI worked correctly. The bug lived exactly in the gap between how it was tested and how
it is used.

**Fix:** `toCallToolResult()` in `src/webmcp/registry.ts` wraps every result centrally,
in the same place that already wraps `execute` for the activity log — fifteen tool
bodies cannot be trusted to each remember. It emits `content` (text, for clients that
read it) plus `structuredContent` (the object, for clients that prefer data), and sets
`isError: true` when the payload carries `ok: false`, so a structured failure surfaces
as an MCP error rather than a silent success.

**The transferable lesson:** test through the path the consumer actually uses. Calling
`executeTool` from page script is not the same thing as being an agent, and the
difference was a total, silent failure of the entire product surface.
