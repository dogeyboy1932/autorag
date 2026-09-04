# Autorag

**A curated retrieval memory that lives in your browser.** You keep passages while
you read, you approve what stays, and you ask questions answered *only* from what
survived — with a citation on every claim.

Live at **<https://autorag-web.netlify.app>** · MIT

---

## Inspiration

Every agent has amnesia, and the usual fixes are worse than the problem. Paste a
document into context and it is gone next session. Point a RAG pipeline at a folder
and it will cheerfully retrieve the stale thing, the duplicate thing, and the thing
you specifically decided was wrong — because nothing in the pipeline ever asked you.

Reading doesn't work like that. You go through a week of articles and keep the four
paragraphs that mattered. **The keeping is the intelligence.** An index built
without it is just a bigger haystack.

WebMCP made that shape possible: the memory lives in the browser, on the pages you
are already reading, and an agent reaches it through `document.modelContext` — no
server in the loop, and passages that never leave the machine unless you ask a
question.

---

## Try it in one click

Open the site and press **Demo mode**. No signup, no key, no Supabase.

It signs in anonymously against the directory, finds the published open session,
pulls a real shared corpus, and drops you into it — you can search it, review what
is pending, and ask it questions. Answers run on the author's key through a Netlify
Function, capped at **ten per visitor**.

It is shared and writable on purpose: what you discard is discarded for the next
visitor too.

Prefer to keep everything local? **Use as guest** — no account, nothing leaves the
browser, and you can make an account later without losing what you kept.

---

## The two surfaces

One engine in `src/rag/`, used by both.

|  | |
|---|---|
| **Web app** | Next.js static export. Capture by pasting, review, search, ask. Three tabs: Ask · Library · Settings. |
| **Extension** | The half a web page cannot do: highlight anything on any site and keep it in one click, read PDFs so their text is selectable at all, ask from the side panel while still on the page. |

```bash
pnpm install && pnpm dev     # web app on http://localhost:3111
pnpm ext                     # build the extension → extension/dist
# brave://extensions → Developer mode → Load unpacked → extension/dist
```

Sign in on the web app and the extension picks the account up automatically — one
identity, one corpus, two doors.

---

## Stack

| Layer | Choice |
|---|---|
| Embeddings | `transformers.js` · `Xenova/all-MiniLM-L6-v2` (384-dim) · WebGPU, WASM fallback |
| Retrieval | Hybrid — cosine fused 60/40 with BM25, typo tolerant, saturating |
| Vector store | Plain array. Brute force is correct under ~10k chunks |
| Persistence | IndexedDB via `idb`; `Float32Array` survives structured clone unchanged |
| Sync | Supabase (PostgREST + RLS), two projects — see below |
| Answering | Anthropic Claude — your key, or the demo endpoint |
| Tool surface | WebMCP on `document.modelContext`, imperative **and** declarative |
| Extension | MV3, esbuild, offscreen document owns the corpus, pdf.js reader |
| Framework | Next.js 16, static export, everything `"use client"` |

---

## Architecture

**Retrieval is local and always has been.** Embedding, chunking, screening, ranking
and storage happen in the browser and go nowhere. Ranking fuses two signals:

```
score = 0.6 · cos(q, c)  +  0.4 · saturate(BM25(q, c))
stale sources are multiplied by 0.6 — demoted, never deleted
```

The lexical half is not decoration. Most queries are two or three keywords, and
dense retrieval is bad at those — `"runtime"` scores 0.127 cosine against the
passage that literally contains the runtime.

**Screening happens on the way in.** Each new passage is compared against the corpus
and flagged as a duplicate (≥0.97), near-duplicate (≥0.88), or a contradiction —
same topic (≥0.72) with disagreeing figures. Flags **nominate, they never judge**.
An agent can rule on a flagged pair with `autorag_adjudicate_conflict`, and the
ruling is written onto the *conflict*, never onto the passage's status.

**A human approves. That is the whole design.** Staging is unrestricted — agent,
extension, paste, all the same. Nothing becomes searchable until a person presses
Keep. `requestUserInteraction` does not exist in any shipping runtime, so the gate
is a UI this project owns, which is the honest design anyway.

**Answering is the only thing that leaves the device.** Ask sends your question and
*only the retrieved passages* to Claude. The prompt forbids filling a gap from the
model's own knowledge even when the gap is small: the corpus is a record of things
you chose to keep, and an answer that blends it with training data destroys the one
property that made it worth keeping. Search alone stays entirely local and free.

**Sharing is two Supabase projects, deliberately.** A **corpus** project holds one
person's passages in a database they own. A separate **directory** project is a
phone book — profiles, session codes, invites — and no passage ever lands in it.
A join code hands out a project's publishable key; if profiles lived in the corpus
project, that key would also address the table holding other people's credentials.
Two projects makes that mistake unreachable. `supabase/corpus.sql` and
`supabase/directory.sql` are idempotent — re-run the whole file to apply a change.

> **Sessions:** a session is what you see. In a session you see that session's
> corpus and nothing else; personal means your local corpus. Anyone in a session has
> full control of it — no user types, no host/joiner distinction.

---

## The tool surface

15 tools: 14 registered imperatively, plus one the browser derives from markup.
`autorag_{verb}_{noun}`, every field described, every error structured. Schemas in
[`lib/tool-design/TOOL-CONTRACT.md`](lib/tool-design/TOOL-CONTRACT.md).

```
ingest_passage   check_conflicts   list_pending      approve_pending
reject_pending   adjudicate_conflict                 search
answer_with_sources                explain_retrieval check_coverage
list_sources     get_stats         mark_stale        forget_source
```

**Registration is dynamic**, which keeps the surface honest: an agent is never
offered `autorag_search` against an empty index, nor approval tools with nothing to
approve. Groups are added and removed with `AbortController`, because
`unregisterTool` does not exist.

**Signals, not verdicts.** `coverageNote()` reports what was retrieved and what
matched; it never tells the agent what to conclude. An earlier version said "the
memory likely does not cover this — say so", which is the retrieval layer
instructing the generation layer on the basis of information it does not have.

---

## Checks

```bash
pnpm typecheck && pnpm sql:check   # types; schema in code vs schema in docs
pnpm ext && pnpm ext:check         # 48 assertions, real browser, real extension
pnpm dir:check                     # directory RLS, as a real anonymous user
pnpm schema:check                  # corpus.sql against a throwaway Postgres
pnpm session:check                 # two profiles, live projects
pnpm loop                          # cross-browser WebMCP conformance
pnpm bench                         # retrieval quality through real tool calls
```

`ext:check` and `dir:check` catch the real regressions. Both are written to fail
loudly rather than pass vacuously — this repo has shipped checks that were green
while measuring nothing, and that is the failure mode being guarded against.

---

## Verified, not assumed

The spec moved while this was built, and the published docs are wrong in places.
Nineteen findings in [`lib/webmcp/API-DELTA.md`](lib/webmcp/API-DELTA.md), each one
verified by running it. The three that changed the design:

- **`execute` takes exactly one argument.** Chrome's docs show a second `{ signal }`.
  It does not exist, native or polyfill.
- **`requestUserInteraction` is not reachable.** No IDL, no argument that could carry
  it — so the human gate is in-page.
- **A PDF's text is in no DOM at all.** Chrome renders through PDFium; a highlight
  there is invisible to every extension. Hence Autorag's own pdf.js reader, which
  makes the selection ordinary DOM and cites the original PDF URL.

Tested on Chrome 151/152 and Brave 1.94 (Chromium 152), native and polyfill.
**D15 is a bug Chrome passed and Brave caught** — two engines was not ceremony.

---

## Repo map

```
src/rag/        the engine: embed · chunk · store · search · screen · ingest · answer · sync
src/webmcp/     registry · lifecycle · errors · tools/
app/ components/  the web app — Shell, three tabs, ReviewQueue (the human gate)
extension/      MV3: background · offscreen (owns the corpus) · sidepanel · reader · content
supabase/       corpus.sql and directory.sql, both idempotent
netlify/        the demo answering endpoint, the only place a key lives
probes/         browser-driven checks — ext, directory, session, schema, ask
lib/            API-DELTA (verified findings) · TOOL-CONTRACT (schemas)
bench/ evals/   retrieval benchmark and QA pairs over a fixed seed corpus
```

Start with **[HANDOFF.md](HANDOFF.md)** to pick up development, or
**[MANUAL.md](MANUAL.md)** to use and test it.

---

## Prior art

Tool-naming rules come out of
[`dogeyboy1932/NodeFlow`](https://github.com/dogeyboy1932/NodeFlow), where dashes in
tool names broke compilation — hence `autorag_{verb}_{noun}`, snake_case throughout.
Fixes went upstream to [`MiguelsPizza/WebMCP`](https://github.com/MiguelsPizza/WebMCP)
as PRs [#22](https://github.com/MiguelsPizza/WebMCP/pull/22) and
[#23](https://github.com/MiguelsPizza/WebMCP/pull/23). `@mcp-b/global` (polyfill) and
`@mcp-b/chrome-devtools-mcp` (the bridge every tool was verified through) are that
project's.

## License

MIT — see [LICENSE](LICENSE).
