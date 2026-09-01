# Autorag

**A browser-native, agent-curated retrieval memory. No server, no API key, no data
leaving the device.**

An agent browses. When it finds something worth keeping, it calls a tool on Autorag to
deposit the passage. Autorag chunks it, embeds it locally, screens it against what it
already knows, and stages it for human review. Approved passages join a persistent
index the agent can query in any future session — with provenance attached.

The human's job shrinks to one thing: **steering what the memory becomes.** The agent
does the gathering and the first-pass screening.

---

## Why this isn't "just paste the doc into context"

Three things a pasted document cannot do:

- **It persists.** Close the tab, close the browser, come back next week — the corpus
  is still there, in IndexedDB. A new agent session inherits everything the last one
  learned.
- **It carries provenance.** Every retrieved passage says which source it came from
  and when it entered the memory. Answers are citable.
- **It was curated.** A person accepted or rejected each passage, and rejections are
  remembered. Propose the same bad source again and the memory tells you why it was
  turned down last time.

---

## Architecture

Autorag has **no LLM**. Tools return passages plus provenance; the calling agent writes
the answer. That single decision removes the API key, the server, the inference cost,
and the streaming UI.

| Layer | Choice |
|---|---|
| Embeddings | `transformers.js`, `Xenova/all-MiniLM-L6-v2` (384-dim), WebGPU with WASM fallback |
| Vector store | Plain array + cosine similarity — brute force is correct under ~10k chunks |
| Persistence | IndexedDB via `idb`; `Float32Array` survives structured clone unchanged |
| Tool surface | WebMCP on `document.modelContext`, imperative **and** declarative |
| Framework | Next.js 16, static export, everything `"use client"` |

Nothing is sent anywhere. The only network request is the one-time model download
from the Hugging Face CDN.

---

## The tool surface

14 tools, `autorag_{verb}_{noun}`, every field described, every error structured.
Full schemas in [`lib/tool-design/TOOL-CONTRACT.md`](lib/tool-design/TOOL-CONTRACT.md).

### Ingestion
| Tool | Read-only | Purpose |
|---|---|---|
| `autorag_ingest_passage` | ✗ | Chunk, embed, screen, stage. Never approves. |
| `autorag_check_conflicts` | ✓ | Dry run — screen without saving. |
| `autorag_list_pending` | ✓ | The review queue. Poll to see the human's decision. |
| `autorag_approve_pending` | ✗ | Commit staged passages. |
| `autorag_reject_pending` | ✗ | Discard with a reason, retained permanently. |
| `autorag_adjudicate_conflict` | ✗ | Agent rules on a flagged pair; advisory only. |

### Retrieval
| Tool | Read-only | Purpose |
|---|---|---|
| `autorag_search` | ✓ | Ranked passages with sources. Approved material only. |
| `autorag_answer_with_sources` | ✓ | Retrieval bundle + confidence + coverage note. |
| `autorag_explain_retrieval` | ✓ | Why these won: raw scores, demotions, near-misses. |
| `autorag_check_coverage` | ✓ | Can the memory support this question at all? |

### Corpus management
| Tool | Read-only | Purpose |
|---|---|---|
| `autorag_list_sources` | ✓ | Paginated, with chunk counts and stale flags. |
| `autorag_get_stats` | ✓ | Counts, date range, model readiness. |
| `autorag_mark_stale` | ✗ | Demote without deleting. |
| `autorag_forget_source` | ✗ | Destructive; requires `confirm: true`. |

Plus `autorag_submit_passage_form`, derived by the browser from an annotated HTML
`<form>` — the **declarative** API, demonstrating both registration paths in one repo.

### Dynamic registration

Groups appear and disappear with corpus state, via `AbortController` (`unregisterTool`
was removed from the spec in April 2026):

- **always** — ingest, screen, stats, sources
- **approval** — only while something is staged
- **retrieval** — only while the approved corpus is non-empty

An agent is never offered `autorag_search` against an empty index.

---

## Curation

Screening **nominates; it never rules.** Cosine distance can tell you two passages are
about the same thing — it cannot tell you they disagree. So:

1. `screen.ts` shortlists pairs by similarity plus differing numeric claims.
2. `autorag_adjudicate_conflict` hands the pair to the calling agent for a verdict.
3. The verdict is attached to the review queue. **The human still decides.**

A note on ordering, because it is counter-intuitive: contradictory passages are
*textually near-identical* — "streaming on Max, 92%" against "streaming on Netflix,
79%" scores 0.93 cosine. Checking near-duplicate first therefore swallows every
contradiction. The differing-figures test has to run first.

---

## Running it

```bash
pnpm install
pnpm dev          # http://localhost:3111
```

WebMCP needs Chrome 149+. Enable it with:

```bash
google-chrome --enable-features=WebMCP
```

The `chrome://flags/#enable-webmcp-testing` entry exists, but the matching
command-line switch does **not** work — see
[`lib/webmcp/API-DELTA.md`](lib/webmcp/API-DELTA.md). `@mcp-b/global` is bundled as a
polyfill for browsers without native support.

First load downloads ~25MB of model weights and caches them. The badge reports
progress honestly; it is not frozen.

---

## Verified, not assumed

The WebMCP spec moved while this was being built, and the published documentation is
wrong in at least one place. Every API claim in
[`lib/webmcp/API-DELTA.md`](lib/webmcp/API-DELTA.md) was verified by running it against
Chrome 151, including three findings that changed the design:

- **`execute` takes exactly one argument.** Chrome's docs show a second `{ signal }`
  parameter. It does not exist, on native or polyfill.
- **`requestUserInteraction` is not reachable.** No IDL, and no argument that could
  carry it. The human gate is therefore in-page, which is the honest design anyway.
- **Aborting a tool group destroys its own in-flight call.** A tool that retracts its
  own group returns `UnknownError` to the agent *after its work has committed*.
  Additions must be synchronous; removals must be deferred.

---

## Repo map

```
app/            page shell
components/     ReviewQueue (the human gate), CorpusView, ActivityLog, declarative form
src/rag/        embed · chunk · store · search · screen · ingest
src/webmcp/     registry · lifecycle · errors · tools/
lib/            API-DELTA (verified findings) · TOOL-CONTRACT (schemas) · demo script
evals/          10 QA pairs over a fixed seed corpus
```

## License

MIT — see [LICENSE](LICENSE).
