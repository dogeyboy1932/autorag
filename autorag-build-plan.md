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

### Phase 0 — De-risk (do before committing a single design decision)
- [ ] Register on Devpost
- [ ] Chrome Canary + `chrome://flags/#enable-webmcp-testing`
- [ ] Console: does `document.modelContext` exist? `navigator.modelContext`? **Write the answer into `lib/webmcp/API-DELTA.md`.**
- [ ] Deploy a blank Next.js page to Vercel registering one trivial tool
- [ ] Call it from ChatGPT's in-app browser. **Do not proceed until this round-trip works.**
- [ ] Install the Model Context Tool Inspector extension
- [ ] **Critical unknown:** does the agent retain your tools while on another tab? Determines whether the agent can harvest and deposit in one flow, or must return to your tab first. Test explicitly.
- [ ] Confirm transformers.js model download works on Vercel (HF CDN reachable, COOP/COEP headers if WASM threads needed)

### Phase 1 — RAG core, no WebMCP
- [ ] Embedding pipeline + warmup indicator
- [ ] Chunker with source metadata
- [ ] IndexedDB store; survives reload
- [ ] Cosine search
- [ ] Crude UI to paste text and search it
- [ ] **Gate:** paste → search → correct chunk returns

### Phase 2 — Tool surface
- [ ] `registry.ts` with feature detection + AbortController lifecycle
- [ ] All ingestion + retrieval tools
- [ ] Structured errors throughout
- [ ] Verify every tool in the Tool Inspector
- [ ] **Gate:** agent ingests and retrieves without you touching the UI

### Phase 3 — Curation layer (the differentiator)
- [ ] `screen.ts` — dedup by similarity threshold, contradiction detection, staleness by date
- [ ] Review queue UI with conflict badges
- [ ] `requestUserInteraction` on approve/reject/forget
- [ ] Dynamic register/unregister on queue state
- [ ] Live activity log of agent calls
- [ ] `autorag_explain_retrieval`
- [ ] **Gate:** a bad source visibly gets caught and rejected

### Phase 4 — Corpus management + polish
- [ ] Source list, stats, mark stale, forget
- [ ] Declarative form
- [ ] Empty/loading/error states
- [ ] Visual polish — this is your video

### Phase 5 — Submission (treat as a deliverable, not a wrap-up)
- [ ] README: architecture, tool table, setup, screenshot
- [ ] MIT LICENSE, confirmed visible in GitHub About
- [ ] Record video (budget 2–3h; always overruns)
- [ ] Text description answering all four required questions verbatim
- [ ] Cite the NodeFlow → MiguelsPizza/WebMCP upstream PRs (#22, #23)
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
