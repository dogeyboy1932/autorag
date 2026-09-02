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

---

## D13. `registerTool` rejects with `AbortError` if its signal fires mid-call

**Verified 2026-09-01, Chrome 151, native.**

`registerTool(tool, { signal })` returns a promise. If `signal` aborts while that
promise is still pending, it **rejects** with `AbortError: signal is aborted without
reason` rather than resolving or settling quietly.

That sounds like an edge case. It is not: it happens on every page load in development.
`registerGroup()` aborts a group's previous controller before installing a new one, so
that ghost tools cannot survive a re-registration — and React StrictMode double-invokes
the effect that calls it. Pass one is still awaiting `registerTool` when pass two aborts
it. Nobody is left to catch the rejection, so it surfaces as:

```
Uncaught (in promise) AbortError: signal is aborted without reason
    at abortGroup    (src/webmcp/registry.ts)
    at registerGroup (src/webmcp/registry.ts)
    at addMissing    (src/webmcp/lifecycle.ts)
    at async ToolRegistrar.useEffect
```

Reproduce by opening the page with an `unhandledrejection` listener installed:

```js
window.__r = [];
addEventListener('unhandledrejection', (e) => window.__r.push(String(e.reason)));
// after load:  window.__r  ->  ["AbortError: signal is aborted without reason"]
```

It is cosmetic — the surviving registration is correct either way, and the bridge
reports all 15 tools. But it is a permanent uncaught error in the console of a page
whose whole argument is that its lifecycle handling is careful, and it would be the
first thing anyone opening DevTools sees.

**Fix:** `registerGroup()` catches around `registerTool` and, if its own controller has
aborted, returns `false` instead of rethrowing — the abort is the intended outcome, not
a failure. `addMissing()` in `lifecycle.ts` then takes its group flags from that return
value rather than setting them optimistically on the next line, so a registration that
declined (no model context) or was aborted mid-flight is retried rather than recorded
as done.

**Relationship to D11.** Same primitive, opposite direction. D11 is an abort destroying
a tool *execution* and is unrecoverable, so the fix is to defer retraction. D13 is an
abort destroying a tool *registration* and is benign, so the fix is to absorb it. Both
came from assuming `abort()` is quiet.

---

## D14. A declarative `<form>` tool is discoverable long before it is callable

**Verified 2026-09-01, Chrome 151, native. This one was shipped broken.**

`getTools()` listed `autorag_submit_passage_form` with a correct input schema from the
day the annotated `<form>` went in, and that was taken as proof the declarative path
worked. It was not. **Calling** the tool through the MCP bridge hung until the bridge
timed out at 120 seconds and staged nothing:

```
call_webmcp_tool autorag_submit_passage_form { … }
-> Runtime.callFunctionOn timed out
-> autorag_get_stats: chunk_count unchanged
```

Three separate things are required, and the form satisfied none of them:

**1. `toolautosubmit`, or nobody ever submits.** Without the attribute the runtime
fills the controls, focuses the first enabled submit button, and *waits for a person to
click it*. An agent call therefore blocks forever. With it, the runtime runs native
constraint validation and calls `requestSubmit()`.

**2. In React it must be written `toolautosubmit=""`.** React drops an unknown attribute
whose value is the boolean `true`, so the JSX shorthand never reaches the DOM. Typed as
`?: ''` in `types/webmcp-jsx.d.ts` so the compiler enforces it.

**3. `SubmitEvent.respondWith()`, or the result never reaches the agent.** An
agent-triggered submit sets `SubmitEvent.agentInvoked`; `respondWith(result)` is the
only channel back. Both must be touched synchronously during dispatch. A handler that
merely calls `preventDefault()` and does its work resolves the agent's call with
nothing.

And then **D12 applies to this path too**, which is how it was missed a second time:
once `respondWith` was wired up the call returned instantly and the bridge still
reported *"completed with no output"*, because a bare object is not a `CallToolResult`.
`toCallToolResult()` is now exported from `src/webmcp/registry.ts` and the form uses the
identical envelope.

Two smaller things fell out of the same test:

- The form-derived tool does not pass through `registerGroup`, so nothing wrapped its
  `execute` for the activity log. Three agent calls landed while the panel still read
  *"No agent calls yet."* `recordActivity()` is now exported for exactly this one caller.
- `event.currentTarget` is null after the first `await` — the handler's own
  `form.reset()` was throwing into its catch block, so a **successful** human submission
  displayed an error string. Capture the element before awaiting.

**The transferable lesson is D12's, one level up.** Appearing in `getTools()` is not
evidence a tool works, in the same way that a passing page-script test was not evidence
a result reaches an agent. The only evidence is a call through the consumer's path that
comes back with the right answer *and* leaves the right state behind.

---

## D15. Resetting a form cancels the tool invocation it is answering

**Verified 2026-09-01 on Brave 1.94.117 / Chromium 152. Chrome 151 did not surface it.**

The declarative form's submit handler cleared its fields after a successful ingest —
ordinary courtesy to whoever typed in them. On Chromium 152 that reset lands while the
agent's invocation is still pending on the same form, and the runtime cancels it:

```
DOMException: UnknownError: Tool execution cancelled by a form reset
```

The passage was already chunked, embedded and staged. The agent was told the call
failed. **This is D11's shape exactly** — work committed, caller handed an opaque error
— reached by a different route: there, aborting a tool group killed its own in-flight
execution; here, resetting a form kills the invocation bound to it. The polyfill
documents reset as a cancellation ("Resetting, removing, or replacing a registration
cancels a pending invocation"); what is easy to miss is that *your own success path* is
one of the things that resets a form.

**Fix:** `if (!submit.agentInvoked) form.reset();` — clear the fields only for a human
submission. Nobody typed into them on the agent path, and leaving them filled has the
side benefit of showing on screen what the agent actually submitted.

**Why Chrome 151 missed it.** Both browsers stage the passage; they differ in whether
the reset arrives before the response is delivered. A timing-dependent bug on one
engine version is a certainty on another, which is the argument for
`pnpm loop --executable <path>` running on more than one browser.

---

## D16. The local relay cannot bridge an `https://` page

**Verified 2026-09-01, Brave 1.94.117 / Chromium 152, `@mcp-b/webmcp-local-relay@5.1.0`.**

`@mcp-b/webmcp-local-relay` is the documented way to let a desktop MCP client call
browser tools. Its widget reaches the relay process over `ws://127.0.0.1:9333`. From an
`https://` page the browser kills that socket during the handshake.

Isolated with everything else held identical — same relay process, same extension, the
MCP client `initialize`d before any page loaded, only the page origin varying:

```
http://localhost:3901/     ->  webmcp_list_sources: { "count": 1 }
https://example.com/       ->  webmcp_list_sources: { "count": 0 }
    console: WebSocket connection to 'ws://127.0.0.1:9333/' failed:
             WebSocket is closed before the connection is established.
```

The widget itself is fine: the blob iframe is created, and it scans 9333 through 9348.
Every socket dies. On the http origin the first one connects.

This was worth isolating carefully, because the first comparison changed two variables
at once (scheme *and* whether the MCP client had initialized) and would have supported
the wrong conclusion.

**Consequence:** the relay is usable for a page you serve yourself on localhost. It
cannot carry tools from the sites a person actually browses.

## D17. `registerTool` rejects with `SecurityError` on an extension-page origin

**Verified 2026-09-01, same build.**

The obvious fix for D16 is to move the bridge into the extension: an offscreen document
owns the corpus, outlives every tab, and its `chrome-extension://` origin is a secure
context that a manifest CSP can permit `ws://127.0.0.1:*` on.

It does not work. `document.modelContext.registerTool()` rejects there with
`SecurityError` — all three tools, every attempt, on both the native surface and the
`@mcp-b/global` polyfill:

```
Could not publish autorag_recall:        SecurityError
Could not publish autorag_memory_stats:  SecurityError
Could not publish autorag_list_sources:  SecurityError
```

Note the error arrives as a bare object: `name` reads `SecurityError`, `message` is
empty, and `JSON.stringify(err)` is `{}`. Logging `err.message` alone shows nothing at
all, which is how this first appeared as three silent failures and a tool count that was
simply short.

### Follow-up: the cause, and the way through

D17 was first measured only in an offscreen document and then generalised to "extension
pages" without testing the others. That generalisation decided an architecture, so it was
worth isolating — `probes/extension-origin-check.mjs` registers a trivial tool from an
ordinary web page (control), the side panel, and a bare extension page in a tab.

Every `chrome-extension://` context rejects, on the polyfill and on native alike. The
polyfill throws a bare `SecurityError` with an empty message; **native Chromium 152 gives
the actual reason**:

```
SecurityError: document.modelContext cannot be used when document.domain is enabled.
```

So it is the origin, not the offscreen context, and not something else the document was
doing. Extension pages are simply not eligible.

**The way through is the intersection of the two constraints, not a way around either.**
D16 says the relay needs an `http` origin. D17 says the registering document cannot be an
extension page. An ordinary page served over plain `http` on localhost satisfies both —
and the extension already does the rest, since its content scripts register the memory
tools on every page and inject the relay embed wherever the origin is `http`.

That is `extension/connector/` (`pnpm bridge`): one small page whose whole job is to exist
at an http origin. Measured end to end in `probes/relay-check.mjs` — a desktop MCP client
starts the relay as a stdio subprocess, finds the tab as a source, lists
`autorag_recall`, and gets back an approved passage with its source URL at high
confidence. 6/6.

**The transferable part:** two constraints that each rule out the obvious design can still
leave exactly one thing standing. It is worth writing both down precisely enough to
intersect them, rather than concluding after the first that the feature is impossible.
