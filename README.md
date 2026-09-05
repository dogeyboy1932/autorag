# Autorag

**A curated retrieval memory that lives in your browser.** Keep passages while you
read, approve what stays, and ask questions answered *only* from what survived —
with a citation on every claim.

**[autorag-web.netlify.app](https://autorag-web.netlify.app)** · MIT

---

## Try it

Open the site → **Demo mode**. No signup, no key. It loads a real shared corpus you
can search, review and ask questions of. Answers run on the author's key, capped at
ten per visitor. Or **Use as guest** to keep everything local.

---

## Why

Agents have amnesia, and the usual fixes are worse than the problem. Paste a doc
into context and it's gone next session. Point RAG at a folder and it retrieves the
stale thing, the duplicate thing, and the thing you already decided was wrong —
because nothing ever asked you.

Reading doesn't work like that. You read a week of articles and keep four
paragraphs. **The keeping is the intelligence.**

---

## How it works

**Retrieval is local.** Embedding, chunking, screening, ranking and storage all
happen in the browser. Ranking fuses two signals, because most queries are two or
three keywords and dense retrieval is bad at those:

```
score = 0.6 · cosine(q, c) + 0.4 · saturate(BM25(q, c))
stale sources × 0.6 — demoted, never deleted
```

**Screening flags on the way in** — duplicate (≥0.97), near-duplicate (≥0.88), or a
contradiction: same topic (≥0.72), disagreeing figures. Flags *nominate*; they never
judge. An agent can rule on a pair, and the ruling is written onto the conflict,
never onto the passage's status.

**A human approves.** Staging is unrestricted — agent, extension, paste, all equal.
Nothing becomes searchable until a person presses Keep.

**Only Ask leaves the device.** It sends your question and the retrieved passages to
Claude, which is forbidden from filling gaps with its own knowledge. Search alone is
entirely local and free.

**Sharing uses two Supabase projects.** A *corpus* project holds your passages; a
separate *directory* holds session codes, invites and profiles — never a passage. A
join code hands out a project's key, so keeping credentials in a second database
makes the obvious mistake unreachable.

---

## Two surfaces, one engine

| | |
|---|---|
| **Web app** | Next.js static export. Three tabs: Ask · Library · Settings |
| **Extension** | What a page can't do: one-click capture on any site, a PDF reader that makes PDF text selectable, side-panel Ask |

Sign in on the web app and the extension picks the account up automatically.

---

## Built with

| | |
|---|---|
| Language | TypeScript, React 19 |
| Web app | Next.js 16 (static export) |
| Extension | Chrome MV3 — offscreen document owns the corpus |
| Agent surface | WebMCP on `document.modelContext` — 15 tools, imperative + declarative |
| Embeddings | transformers.js · `all-MiniLM-L6-v2` (384-dim) · WebGPU, WASM fallback |
| Retrieval | Hybrid cosine + BM25, brute force (correct under ~10k chunks) |
| Local store | IndexedDB via `idb` |
| Sync | Supabase — PostgREST, RLS, pgvector |
| Answering | Anthropic Claude (your key, or the demo endpoint) |
| PDF | pdf.js |
| Hosting | Netlify + one Function (the only place a key lives) |

## Tooling

| | |
|---|---|
| Development | **Claude Code** (Opus 5) — implementation, RLS review, check suites |
| Agent client | `@mcp-b/chrome-devtools-mcp` — how every tool was driven and verified |
| WebMCP polyfill | `@mcp-b/global`, `@mcp-b/webmcp-local-relay` |
| Bundler | esbuild (extension), Turbopack (web) |
| Browser automation | Puppeteer — 48-assertion extension suite, retrieval benchmark |
| Package manager | pnpm |
| Tested on | Chrome 151/152, Brave 1.94 (Chromium 152) — native and polyfill |

---

## Run it

```bash
pnpm install && pnpm dev     # web app → localhost:3111
pnpm ext                     # extension → extension/dist
# brave://extensions → Developer mode → Load unpacked
```

## Checks

```bash
pnpm typecheck && pnpm sql:check   # types; schema in code vs schema in docs
pnpm ext:check                     # 48 assertions, real browser, real extension
pnpm dir:check                     # directory RLS, as a real anonymous user
pnpm session:check                 # two profiles, live projects
pnpm loop && pnpm bench            # WebMCP conformance; retrieval quality
```

Written to fail loudly rather than pass vacuously — this repo has shipped checks
that were green while measuring nothing.

## Repo map

```
src/rag/       the engine — embed · chunk · store · search · screen · ingest · answer · sync
src/webmcp/    tool registry, lifecycle, errors
app/ components/   web app — three tabs, ReviewQueue is the human gate
extension/     MV3 — background · offscreen · sidepanel · reader · content scripts
supabase/      corpus.sql, directory.sql — both idempotent
netlify/       demo answering endpoint
probes/        browser-driven checks
lib/           API-DELTA (19 verified spec findings) · TOOL-CONTRACT (schemas)
```

Picking up development? → **[HANDOFF.md](HANDOFF.md)**

## Notes

The WebMCP spec moved while this was built; 19 verified findings are in
[`lib/webmcp/API-DELTA.md`](lib/webmcp/API-DELTA.md). Three changed the design:
`execute` takes one argument (docs show two), `requestUserInteraction` isn't
reachable in any shipping runtime (so the human gate is in-page), and a PDF's text
is in no DOM at all (hence the bundled reader).

Tool naming comes from [NodeFlow](https://github.com/dogeyboy1932/NodeFlow); fixes
went upstream to [MiguelsPizza/WebMCP](https://github.com/MiguelsPizza/WebMCP)
([#22](https://github.com/MiguelsPizza/WebMCP/pull/22),
[#23](https://github.com/MiguelsPizza/WebMCP/pull/23)).

MIT — see [LICENSE](LICENSE).
