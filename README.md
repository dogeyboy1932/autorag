# Autorag

**A browser-native, agent-curated retrieval memory. No server, no API key, no data
leaving the device.**

An agent browses. When it finds something worth keeping, it calls a tool on Autorag to
deposit the passage. Autorag chunks it, embeds it locally, screens it against what it
already knows, and stages it for human review. Approved passages join a persistent
index the agent can query in any future session — with provenance attached.

The human's job shrinks to one thing: **steering what the memory becomes.** The agent
does the gathering and the first-pass screening.

![Autorag: a staged passage in the review queue, flagged against an approved one, with
the calling agent's verdict attached and the human's approve/reject buttons still
unpressed](public/screenshot.png)

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
| Retrieval | Hybrid: cosine similarity fused 60/40 with BM25, plus typo tolerance |
| Vector store | Plain array — brute force is correct under ~10k chunks |
| Persistence | IndexedDB via `idb`; `Float32Array` survives structured clone unchanged |
| Tool surface | WebMCP on `document.modelContext`, imperative **and** declarative |
| Framework | Next.js 16, static export, everything `"use client"` |

Nothing is sent anywhere. The only network request is the one-time model download
from the Hugging Face CDN.

---

## The tool surface

15 tools an agent can see: 14 registered imperatively, listed below, plus one the
browser derives from markup. `autorag_{verb}_{noun}`, every field described, every error
structured. Full schemas in [`lib/tool-design/TOOL-CONTRACT.md`](lib/tool-design/TOOL-CONTRACT.md).

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
| `autorag_get_stats` | ✓ | Counts, date range, embedding model and dimensions, readiness. |
| `autorag_mark_stale` | ✗ | Demote without deleting. |
| `autorag_forget_source` | ✗ | Destructive; requires `confirm: true`. |

Plus `autorag_submit_passage_form`, derived by the browser from an annotated HTML
`<form>` — the **declarative** API, demonstrating both registration paths in one repo.
It is verified by being *called* through an MCP bridge, not by appearing in `getTools()`:
it listed correctly for most of this build while being completely non-functional
([API-DELTA D14](lib/webmcp/API-DELTA.md)).

### Dynamic registration

Groups appear and disappear with corpus state, via `AbortController` (`unregisterTool`
was removed from the spec in April 2026):

- **always** — ingest, screen, stats, sources
- **approval** — only while something is staged
- **retrieval** — only while the approved corpus is non-empty

An agent is never offered `autorag_search` against an empty index.

---

## Retrieval quality

Dense embeddings alone handle full questions well and ordinary typing badly. Measured
on `bench/`, a dense-only index put the correct source first for 85% of realistic
queries but scored eight of twenty-one *correct* retrievals below the confidence floor
— finding the right answer and then telling the agent to distrust it.

Two changes fixed it:

- **Hybrid ranking.** BM25 over title-prefixed passages, fused 60/40 with cosine, with
  edit-distance typo correction for terms of five characters or more. Bare numbers,
  proper nouns and rating codes are exactly where dense similarity is weakest.
- **Calibrated confidence.** An absolute cosine cutoff is wrong because similarity
  scales with query length — "runtime" scores 0.127 against the passage that literally
  contains the runtime. Confidence keys on how much of the query's vocabulary the
  passage actually covers, falling back to the dense score for paraphrase.

Run it yourself with `pnpm bench` against a running dev server.

### Signals, not verdicts

Autorag has no language model and cannot see the caller's conversation, so it does not
decide whether a question is answerable — that is the agent's job (AD-1). It reports
what it found and how well it matched, and always returns passages.

The distinction matters most on follow-ups. "how long is it" and "how do I bake
sourdough" both score ≈0.08 and are indistinguishable by score alone. But they are not
the same situation, and the agent is told so:

| Query | What Autorag reports |
|---|---|
| `how long is it` | *"This query refers to something it does not name, which only you can resolve — so the score reflects wording, not whether the answer is here. Judge these passages on their content."* |
| `how do I bake sourdough` | *"No passage contains "bake", "sourdough" — the match rests on meaning rather than wording."* |

The first is answerable and the passages contain the runtime; only the agent knows what
"it" refers to. The second genuinely is not covered. An earlier version emitted *"say so
rather than inferring an answer"* for both — the retrieval layer instructing the
generation layer on the basis of information it does not have.

```
top-1 21/21    no overclaim 3/3    no withhold 25/25
```

`no withhold` is the load-bearing one: passages come back on every query, so the agent
always has something to judge rather than being told to give up.

### Evaluating the tool surface itself

`evals/` holds eleven questions over a fixed seed corpus, each answerable only by
calling the tools. They test **the contract, not the model**: if the right arguments are
not guessable from a schema, or a result does not answer the question its description
promises, that is a bug in the description.

The run is written up in [`evals/RESULTS.md`](evals/RESULTS.md) — 11/11 against the
answer key, and five defects in descriptions and payloads found and fixed by running it.
It states its own limit plainly: the caller knew the repo, so it proves the arguments
and the results, not the tool *choice*. Only an agent that has never seen this code can
prove that.

---

## Curation

Screening **nominates; it never rules.** Cosine distance can tell you two passages are
about the same thing — it cannot tell you they disagree. So:

1. `screen.ts` shortlists pairs that are on the same subject and each carry numbers the
   other does not.
2. `autorag_adjudicate_conflict` hands the pair to the calling agent for a verdict.
3. The verdict is attached to the review queue. **The human still decides.**

Step 1 is a symmetric difference over numeric tokens, and the flag says exactly that —
"this passage has 79; that one has 92, 500, 95" — rather than "the figures differ". The
weaker sentence is the true one: a release year present in one passage and absent from
the other lands in that list identically to two disagreeing review scores, and telling
them apart means reading the claims around the numbers. That is step 2's job.

A note on ordering, because it is counter-intuitive: contradictory passages are
*textually near-identical* — "streaming on Max, 92%" against "streaming on Netflix,
79%" scores 0.93 cosine. Checking near-duplicate first therefore swallows every
contradiction. The differing-figures test has to run first.

---

## New here?

- **Picking up development?** Start with **[HANDOFF.md](HANDOFF.md)** — current state,
  what is verified, what is not, and what is left.
- **Want to use or test it?** Read **[MANUAL.md](MANUAL.md)** — what this is, how to run
  it, and a ten-minute test plan in plain language.

This README assumes you already know what WebMCP is.

## Running it

```bash
pnpm install
pnpm dev          # http://localhost:3111
```

WebMCP needs a Chromium 149+ build. Enable it with:

```bash
google-chrome --enable-features=WebMCP
brave-browser --enable-features=WebMCP     # works too, verified on Chromium 152
```

The `chrome://flags/#enable-webmcp-testing` entry exists, but the matching
command-line switch does **not** work — see
[`lib/webmcp/API-DELTA.md`](lib/webmcp/API-DELTA.md). `@mcp-b/global` is bundled as a
polyfill for browsers without native support.

First load downloads ~25MB of model weights and caches them. The badge reports
progress honestly; it is not frozen.

### Where this has been tested

| Browser | WebMCP | Result |
|---|---|---|
| Chrome 151 | native, `--enable-features=WebMCP` | full loop, dev server and static export |
| Chrome 151 | `@mcp-b/global` polyfill | full loop |
| **Brave 1.94.117** (Chromium 152) | native, `--enable-features=WebMCP` | **15/15** — `pnpm loop` |
| Brave 1.94.117 | `@mcp-b/global` polyfill | tools register and execute |

Brave ships the feature: launch it with `--enable-features=WebMCP` and
`document.modelContext` is there before any page script runs. Without the flag the
polyfill takes over and the page still works.

Run the conformance suite against any Chromium build yourself:

```bash
pnpm loop                                        # Brave
pnpm loop --executable /usr/bin/google-chrome    # Chrome
```

It drives the entire product through `executeTool` — never the UI — and exits non-zero
on any failure. Testing on two engines was not ceremony: **D15 is a bug Chrome 151
passed and Brave caught.**

Other WebMCP hosts — ChatGPT's in-app browser among them — are **untested**. The tool
surface is standard `document.modelContext` with no browser-specific calls, so it should
port, but we have not run it and do not claim it.

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
bench/          retrieval benchmark (pnpm bench)
probes/         cross-browser WebMCP conformance run (pnpm loop) + API-DELTA probes
app/            page shell
components/     ReviewQueue (the human gate), CorpusView, ActivityLog, declarative form
src/rag/        embed · chunk · store · search · screen · ingest
src/webmcp/     registry · lifecycle · errors · tools/
lib/            API-DELTA (verified findings) · TOOL-CONTRACT (schemas) · demo script
evals/          11 QA pairs over a fixed seed corpus, plus RESULTS.md
```

## Prior art and upstream

The tool-naming rules in
[`lib/tool-design/TOOL-CONTRACT.md`](lib/tool-design/TOOL-CONTRACT.md) come out of
[`dogeyboy1932/NodeFlow`](https://github.com/dogeyboy1932/NodeFlow), where dashes in
tool names broke compilation — hence `autorag_{verb}_{noun}`, snake_case throughout.

Fixes from that work were contributed upstream to
[`MiguelsPizza/WebMCP`](https://github.com/MiguelsPizza/WebMCP) as PRs
[#22](https://github.com/MiguelsPizza/WebMCP/pull/22) and
[#23](https://github.com/MiguelsPizza/WebMCP/pull/23).

`@mcp-b/global` (the polyfill) and `@mcp-b/chrome-devtools-mcp` (the bridge every tool
here was verified through) are that project's, and
[`WebMCP-org/chrome-devtools-quickstart`](https://github.com/WebMCP-org/chrome-devtools-quickstart)
is where the dev loop came from.

## License

MIT — see [LICENSE](LICENSE).
