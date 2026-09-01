# Devpost submission — draft text

Fill the URLs in once deployed. Everything else is ready to paste.

- **Live URL:** _(pending deploy)_
- **Repo:** _(pending push)_
- **Video:** _(pending recording)_

---

## Tagline

A browser-native, agent-curated retrieval memory. The agent gathers; you decide what
it keeps. No server, no API key, nothing leaves the device.

---

## Inspiration

Agents forget. Every session starts cold, and the usual fix — paste the document into
context — fails in three specific ways: it does not persist across sessions, it carries
no provenance, and nobody ever decided whether the material was any good. We wanted a
memory that survives the session, cites its sources, and has a human's judgment baked
into it.

## What it does

An agent browses. When it finds something worth keeping it calls
`autorag_ingest_passage`. Autorag chunks the passage, embeds it locally, screens it
against everything already known, and stages it for review. Conflicts get flagged; the
agent can rule on them with `autorag_adjudicate_conflict`; a human approves or rejects,
and rejections are remembered with their reasons. Approved passages join a persistent
index the agent can query in any later session, always with provenance.

## How we built it

Everything client-side. Embeddings run in the tab through transformers.js
(all-MiniLM-L6-v2, 384 dimensions, WebGPU with a WASM fallback). The index is a plain
array with cosine similarity — brute force is the right answer under ten thousand
chunks — persisted to IndexedDB, where `Float32Array` survives structured clone
unchanged. Next.js 16 as a static export, every line `"use client"`.

The key architectural decision: **Autorag has no LLM.** Tools return passages plus
provenance and the calling agent writes the answer. That removed the API key, the
server, the inference cost and the streaming UI in one stroke, and it is what makes
"nothing leaves the device" literally true rather than aspirational.

14 tools are exposed over WebMCP on `document.modelContext`, registered imperatively,
plus one more the browser derives from an annotated HTML `<form>` — both registration
APIs in the same repo. Tool groups register and unregister dynamically with
`AbortController` as corpus state changes, so an agent is never offered a search tool
against an empty index.

## Challenges we ran into

The spec moved underneath us, so we verified every API claim by running it rather than
reading it. Three findings changed the design, all documented in
`lib/webmcp/API-DELTA.md`:

**`execute` takes one argument.** Chrome's published docs show a second `{ signal }`
parameter. It does not exist — not on native Chrome 151, not on the polyfill.

**`requestUserInteraction` is not reachable.** It is in no IDL, and there is no
argument to `execute` that could carry it. Our original design put the human approval
gate on that API. Moving it in-page turned out to be the better design regardless: the
person is visibly the gate, on screen, rather than behind a browser dialog.

**Aborting a tool group destroys that group's own in-flight call.** `abort()` is
specified as safe for in-flight executions; in Chrome 151 it is not, when the executing
tool belongs to the group being aborted. `autorag_approve_pending` empties the review
queue and so retracts its own group — the approval committed to IndexedDB and *then*
the agent received an opaque `UnknownError`. A retry then returned `NOT_FOUND`: silent
success reported as unrecoverable failure. The fix is a strict split — registrations
synchronous so an agent finds the tool it was told to poll, retractions deferred until
after the call returns.

One more, in our own code: contradiction detection was inverted. Contradictory passages
are *textually near-identical* — "streaming on Max, 92%" against "streaming on Netflix,
79%" scores 0.93 cosine — so the near-duplicate check was swallowing every
contradiction before the contradiction check could run. The differing-figures test has
to go first.

## Accomplishments we're proud of

The curation loop closes. A bad source gets flagged on similarity plus differing
figures, the agent rules on it, a human rejects it with a reason — and when that same
material is proposed again, the memory hands back the human's own words explaining why
it was turned down. That is memory with judgment in it, not just storage.

## What we learned

Screening should nominate, never rule. Embedding distance can establish that two
passages are about the same subject; it cannot establish that they disagree. Pretending
otherwise would have been an overclaim, so the heuristic shortlists and the agent
adjudicates and the human decides — three steps, each doing only what it is actually
capable of.

## What's next

Cross-tab composition through `exposedTo`, sparse-region detection over the embedding
space for genuine gap analysis rather than the honest coverage check we shipped, and a
measured token comparison against DOM-driven automation for the same workflow.

---

## Required questions

**What does your app do?**
Autorag is a persistent, curated retrieval memory that lives in the browser. An agent
deposits passages it finds while browsing; Autorag chunks, embeds and screens them
locally, then stages them for human approval. Approved passages become searchable in
every future session, with provenance attached to every result.

**How does it use WebMCP?**
14 tools registered imperatively on `document.modelContext`, plus one derived
declaratively from an annotated HTML `<form>`. Tool groups are registered and retracted
dynamically with `AbortController` as corpus state changes: approval tools exist only
while something is staged, retrieval tools only while the corpus is non-empty. Every
tool has an explicit input schema with per-field descriptions, an accurate
`readOnlyHint`, and structured errors that name a suggested next tool.

**Who is it for?**
Anyone whose agent keeps re-reading the same material and still gets it wrong — and who
wants a say in what their agent believes rather than accepting whatever it scraped.

**What's novel about it?**
Browser-side RAG is commodity and MCP servers wrapping ingest/search are commodity.
What is not: the calling agent is the generation layer, so there is no server, no API
key and no inference cost; the memory persists across sessions and across agents
because the page *is* the store; every retrieval carries provenance; and the corpus is
human-shaped rather than indiscriminate, with rejections remembered and replayed.
