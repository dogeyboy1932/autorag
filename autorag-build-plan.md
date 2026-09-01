# Autorag — Build Plan

**A browser-native, agent-curated retrieval memory. No server, no API key, no data leaving the device.**

---

## 1. The concept, stated for judges

An agent browses. When it finds something worth keeping, it calls a tool on Autorag
to deposit the passage. Autorag chunks it, embeds it locally, checks it against what
it already knows, and stages it for human approval. Approved chunks join a persistent
index the agent can query in any future session.

The human's job shrinks to one thing: **judging quality at a review gate.** The agent
does the gathering and the first-pass screening.

**Framing rules (non-negotiable):**
- Never say "train." Nothing is being trained. Say *ingest*, *index*, *memory*, *corpus*.
- The claim is **persistent, curated, provenance-tracked retrieval memory** — not a smarter model.
- The pasteable-context objection ("why not just paste the doc?") must be answered by
  volume, cross-session persistence, and visible curation. Design against it.

---

## 2. Architecture decisions

### AD-1: The agent is the generation layer
Autorag has no LLM. Tools return chunks + provenance; the calling agent synthesizes
the answer. **Consequences:** no API key, no server, no inference cost, no streaming
UI to build. This is the single biggest scope reduction available.

### AD-2: Everything client-side
| Layer | Choice | Notes |
|---|---|---|
| Embeddings | `transformers.js`, `all-MiniLM-L6-v2` (384-dim) | WebGPU with WASM fallback |
| Vector store | Plain JS array + cosine similarity | Brute force is fine under ~10k chunks. Do not add a vector DB. |
| Persistence | IndexedDB (via `idb`) | Chunks, embeddings (Float32Array), sources, decisions |
| Framework | Next.js (static export or client-only) + Vercel | All logic in `"use client"` |
| Optional UI | React Flow — corpus as a graph | Reuse from NodeFlow. Cut if time-pressed. |

### AD-3: The agent harvests; the app ingests
No browser extension. No cross-origin scraping. The agent navigates elsewhere, reads,
returns to Autorag, and calls `autorag_ingest_passage`. Keeps 100% of the engineering
inside the thing being judged.

### AD-4: Human gate on write, not on read
`requestUserInteraction` fires on **batch approval** and **destructive ops only**.
Never on search. Gating every read makes the agent unusable.

---

## 3. Tool surface

Naming follows `autorag_{action}_{resource}`, snake_case, no dashes (dashes broke tool
compilation in NodeFlow). Every tool: explicit `inputSchema` with per-field descriptions,
correct `readOnlyHint`, try/catch returning a structured error with a suggested next tool.

### Ingestion
| Tool | readOnly | Purpose |
|---|---|---|
| `autorag_ingest_passage` | false | `{text, source_url, title, tags?}` → chunk, embed, screen, stage. Returns staged IDs + conflict flags. |
| `autorag_check_conflicts` | true | Dry-run a passage against the index before ingesting. Returns duplicates, contradictions, staleness signals. |
| `autorag_list_pending` | true | The review queue. Paginated. |
| `autorag_approve_pending` | false | **Gated by `requestUserInteraction`.** Commits staged chunks. |
| `autorag_reject_pending` | false | **Gated.** Rejects with a reason; reason is retained and returned in future conflict checks. |

### Retrieval
| Tool | readOnly | Purpose |
|---|---|---|
| `autorag_search` | true | `{query, k, filters?}` → ranked chunks with scores. Paginated. |
| `autorag_answer_with_sources` | true | Retrieval bundle: chunks + source URLs + ingest dates + confidence. The demo's centerpiece. |
| `autorag_explain_retrieval` | true | Why these chunks won — scores, what was near-miss. No UI equivalent. |

### Corpus management
| Tool | readOnly | Purpose |
|---|---|---|
| `autorag_list_sources` | true | Paginated: `has_more`, `next_offset`, `total_count`. |
| `autorag_get_stats` | true | Chunk count, source count, date range, conflict count. |
| `autorag_mark_stale` | false | Flag a source as outdated without deleting; demotes it in ranking. |
| `autorag_forget_source` | false | **Gated + destructive.** Removes a source and its chunks. |

### Declarative API (cheap credibility)
Add one HTML `<form>` for manual paste with `toolname` / `tooldescription` /
`toolparamdescription` attributes. Demonstrates both registration APIs in one repo.

### Dynamic registration
Approval tools register **only when the pending queue is non-empty**; unregister when
drained. `autorag_search` unregisters when the corpus is empty. Wire to an
`AbortController` per React component so SPA navigation can't leave ghost tools.

---

## 4. Repo structure

```
autorag/
├── LICENSE                  # MIT — must be detectable in GitHub About
├── README.md                # Setup, architecture, tool table, demo script
├── lib/                     # Reference material (see §5)
├── app/
│   ├── page.tsx             # Shell
│   └── layout.tsx
├── components/
│   ├── ReviewQueue.tsx      # The human gate — the star of the video
│   ├── CorpusView.tsx       # Source list / graph
│   ├── ConflictBadge.tsx
│   └── ActivityLog.tsx      # Every agent tool call, live
├── src/
│   ├── webmcp/
│   │   ├── registry.ts      # Feature-detect document vs navigator; register/unregister
│   │   ├── tools/           # One file per tool
│   │   └── errors.ts        # Structured error helper
│   ├── rag/
│   │   ├── embed.ts         # transformers.js pipeline, singleton, warmup
│   │   ├── chunk.ts         # Recursive splitter, overlap, metadata
│   │   ├── store.ts         # IndexedDB CRUD
│   │   ├── search.ts        # Cosine + filters + staleness demotion
│   │   └── screen.ts        # Dedup, contradiction, staleness heuristics
│   └── types.ts
└── evals/
    └── autorag_eval.xml     # §8
```

---

## 5. `lib/` — reference material

Vendored docs your coding agent reads instead of guessing at a spec that shifted
three months ago. Fetch these into `lib/` before writing any code.

```
lib/
├── README.md                        # Index + "read this first" ordering
├── webmcp/
│   ├── spec-snapshot.md             # webmachinelearning.github.io/webmcp
│   ├── imperative-api.md            # developer.chrome.com/docs/ai/webmcp/imperative-api
│   ├── declarative-api.md           # developer.chrome.com/docs/ai/webmcp
│   ├── secure-tools.md              # .../webmcp/secure-tools  (exposedTo)
│   ├── openai-guide.md              # learn.chatgpt.com/docs/webmcp
│   ├── use-webmcp-tool.md           # GoogleChromeLabs/use-webmcp-tool README
│   └── API-DELTA.md                 # ⚠️ You write this: document vs navigator,
│                                    #    what your Canary build actually exposes
├── tool-design/
│   ├── mcp-best-practices.md        # Naming, pagination, errors, annotations
│   └── TOOL-CONTRACT.md             # ⚠️ You write this: your 12 tools, schemas,
│                                    #    error codes. Written BEFORE the app.
├── rag/
│   ├── transformers-js.md           # huggingface.co/docs/transformers.js
│   └── chunking-notes.md            # Chunk size, overlap, metadata decisions
└── demo/
    └── DEMO-SCRIPT.md               # ⚠️ You write this. See §7.
```

The three ⚠️ files are yours and are the highest-value documents in the repo.
`TOOL-CONTRACT.md` in particular: **write the schemas before the app.** The schemas
are the product being judged.

---

## 6. Build sequence

### Phase 0 — De-risk — **COMPLETE, with two items deliberately dropped**
- [x] Register on Devpost
- [x] ~~Chrome Canary + `chrome://flags/#enable-webmcp-testing`~~ — the flag exists but
      the matching command-line switch does not work. Use
      `google-chrome --enable-features=WebMCP`.
- [x] Console: `document.modelContext` — answered in API-DELTA D1
- [ ] ~~Deploy a blank Next.js page to Vercel~~ — **dropped.** Deploy is a Phase 5 task
      and no longer de-risks anything; the whole app builds and runs as a static export.
- [ ] ~~Call it from ChatGPT's in-app browser~~ — **out of scope by decision.** Chrome is
      the tested surface; the docs claim nothing about other hosts (`HUMAN-TASKS.md` §1).
- [x] ~~Model Context Tool Inspector~~ — superseded by the MCP bridge, see Phase 2
- [x] **Critical unknown — resolved:** does not matter. AD-3 has the agent return to the
      Autorag tab to deposit, so tool retention across tabs is not on the critical path.
- [x] transformers.js model download works; COOP/COEP deliberately NOT set — they would
      block the cross-origin HF CDN fetch. See `next.config.mjs`.

### Phase 1 — RAG core, no WebMCP — **COMPLETE**
- [x] Embedding pipeline + warmup indicator
- [x] Chunker with source metadata
- [x] IndexedDB store; survives reload
- [x] Cosine search — *now hybrid dense+BM25, see README "Retrieval quality"*
- [x] Crude UI to paste text and search it
- [x] **Gate PASSED** (re-verified 2026-09-01): paste → search → correct chunk, and the
      corpus survives a full reload. `pnpm bench` 21/21 top-1.

### Phase 2 — Tool surface — **COMPLETE**
- [x] `registry.ts` with feature detection + AbortController lifecycle
- [x] All ingestion + retrieval tools — 14 imperative, 1 form-derived
- [x] Structured errors throughout
- [x] ~~Verify every tool in the Tool Inspector~~ — superseded: every tool is verified
      through the **MCP bridge** instead, which is the path agents actually use. The
      extension would not have caught D12 or D14.
- [x] **Gate PASSED** (re-verified 2026-09-01): ingest ×4, adjudicate, reject, approve,
      search — driven entirely through `call_webmcp_tool`, zero UI interaction.

### Phase 3 — Curation layer (the differentiator) — **COMPLETE**
- [x] `screen.ts` — dedup by similarity threshold, contradiction detection, staleness by date
- [x] Review queue UI with conflict badges
- [x] ~~`requestUserInteraction` on approve/reject/forget~~ — **impossible.** The API does
      not exist in any shipping runtime (API-DELTA D4). The human gate is in-page, which
      is the better design: the person is visibly the gate, on screen.
- [x] Dynamic register/unregister on queue state
- [x] Live activity log of agent calls — *the form-derived tool was missing from it until
      2026-09-01; fixed*
- [x] `autorag_explain_retrieval`
- [x] **Gate PASSED** (re-verified 2026-09-01): an undated blog claiming a free Netflix
      stream was flagged against the dated JustWatch listing, adjudicated by the agent,
      rejected with a reason, and on re-proposal the memory returned that reason.
      *Known limit: it caught one of the two real disagreements in that post — see
      `evals/RESULTS.md`.*

### Phase 4 — Corpus management + polish — **COMPLETE**
- [x] Source list, stats, mark stale, forget — all four exercised through the bridge,
      including the destructive path with and without `confirm`
- [x] Declarative form — *listed correctly from the start but did **not work** until
      2026-09-01; three separate causes, see API-DELTA D14*
- [x] Empty/loading/error states
- [x] Visual polish — screenshot in the README

### Phase 5 — Submission (treat as a deliverable, not a wrap-up)
- [x] README: architecture, tool table, setup, screenshot
- [x] MIT LICENSE in the repo — *visibility in GitHub's About panel needs the push*
- [ ] Record video (budget 2–3h; always overruns) — script in `lib/demo/DEMO-SCRIPT.md`
- [x] Text description answering all four required questions verbatim — `SUBMISSION.md`
- [x] Cite the NodeFlow → MiguelsPizza/WebMCP upstream PRs (#22, #23) — README + SUBMISSION
- [ ] Submit with buffer

**Hard rule:** Phase 5 is not optional polish. Reserve real time for it.

---

## 7. Demo design (write `lib/demo/DEMO-SCRIPT.md` early)

Under 3 minutes, audio required. Target arc:

1. **(20s)** Ask a question. Agent answers **confidently wrong or stale.**
2. **(90s)** Agent browses, ingests 3–4 sources. One trips a conflict flag. Human reviews and rejects it on camera. Approves the rest.
3. **(40s)** Same question. Correct answer **with provenance** — which sources, when ingested.
4. **(20s)** Close on the architecture claim: no server, no API key, nothing left the device.

Wrong→right beats empty→full. Provenance is the thing pasting into context cannot give you.

**Corpus choice is deferred** — but note it must be a domain where sources naturally
contradict or go stale, or the curation layer has nothing to do on camera.

---

## 8. Evaluations (adapted from mcp-builder Phase 4)

Optional for submission, strong signal if included. After the corpus exists, write
~10 questions in `evals/autorag_eval.xml`:

```xml
<evaluation>
  <qa_pair>
    <question>...</question>
    <answer>...</answer>
  </qa_pair>
</evaluation>
```

Each: independent, read-only, requiring multiple tool calls, verifiable by string
comparison, stable over time. Mentioning that you evaluated your own tool surface
lands well with this judging panel.

**Done (2026-09-01).** Eleven questions, run end to end through the MCP bridge, 11/11
against the key — and five tool-contract defects found and fixed on the way. Write-up in
`evals/RESULTS.md`, which also states what the run does not prove: the caller knew the
repo, so tool *choice* is still unverified. See `HANDOFF.md` §5.

---

## 9. Resources

**Spec & docs**
- Spec — `https://webmachinelearning.github.io/webmcp/`
- Chrome — `https://developer.chrome.com/docs/ai/webmcp`
- Imperative API — `https://developer.chrome.com/docs/ai/webmcp/imperative-api`
- Secure tools / `exposedTo` — `https://developer.chrome.com/docs/ai/webmcp/secure-tools`
- Lighthouse audit — `https://developer.chrome.com/docs/lighthouse/agentic-browsing/registered-webmcp-tools`
- OpenAI guide — `https://learn.chatgpt.com/docs/webmcp`
- OpenAI showcase — `https://developers.openai.com/showcase`

**Repos**
- `GoogleChromeLabs/use-webmcp-tool` — React hook, maintained by Chrome, tracks spec
- `MiguelsPizza/WebMCP` — Alex Nahas (judge); your PRs #22, #23 live here
- `GoogleChrome/modern-web-guidance-src` — `guides/webmcp/webmcp/guide.md`
- `googlechromelabs.github.io/webmcp-tools/demos/explainer/` — live reference impl
- `@mcp-b/global` — polyfill
- `dogeyboy1932/NodeFlow` — your prior art

**RAG stack**
- `huggingface.co/docs/transformers.js` — `Xenova/all-MiniLM-L6-v2`
- `idb` (Jake Archibald) — IndexedDB wrapper
- React Flow — optional corpus graph

**Tooling**
- Model Context Tool Inspector (Chrome extension) — see what the agent sees
- Chrome Canary + `chrome://flags/#enable-webmcp-testing`

---

## 10. Open decisions

1. **Corpus/topic for the demo** — deferred to post-architecture
2. **React Flow canvas or conventional UI** — depends on Phase 3 time remaining
3. **Contradiction detection method** — embedding-distance heuristic vs. asking the calling agent to adjudicate via a tool round-trip. The latter is more interesting and more fragile.
4. **`exposedTo`** — out of scope unless everything else lands early
