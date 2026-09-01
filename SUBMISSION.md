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

**A declarative form tool is discoverable long before it is callable.** Ours listed
correctly in `getTools()` with a clean input schema from the day the annotated `<form>`
went in, and we recorded it as working on that basis. It was not. Calling it hung until
the bridge timed out at 120 seconds and stored nothing. Three things are required and we
had none: `toolautosubmit`, or the runtime just focuses the submit button and waits for a
person who is not there; the React spelling `toolautosubmit=""`, because React drops an
unknown attribute whose value is boolean `true`; and `SubmitEvent.respondWith()`, the
only channel back to the agent. Then the envelope bug above bit a second time on the same
path. Fixed and verified by calling it — it now returns a result *and* stages the
passage.

That is the lesson of this project in one bug: **appearing in `getTools()` is not
evidence a tool works.** The only evidence is a call through the path the consumer uses
that comes back right and leaves the right state behind.

One more, in our own code: contradiction detection was inverted. Contradictory passages
are *textually near-identical* — "streaming on Max, 92%" against "streaming on Netflix,
79%" scores 0.93 cosine — so the near-duplicate check was swallowing every
contradiction before the contradiction check could run. The differing-figures test has
to go first.

## Prior art and upstream

Tool-naming conventions came out of `dogeyboy1932/NodeFlow`, where dashes in tool names
broke compilation — hence `autorag_{verb}_{noun}` throughout. Fixes from that work went
upstream to `MiguelsPizza/WebMCP` as PRs #22 and #23. The polyfill (`@mcp-b/global`) and
the bridge every tool here was verified through (`@mcp-b/chrome-devtools-mcp`) are that
project's.

## Accomplishments we're proud of

The curation loop closes. A bad source gets flagged for being on the same subject as
something known while carrying numbers that one does not, the agent rules on it, a human rejects it with a reason — and when that same
material is proposed again, the memory hands back the human's own words explaining why
it was turned down. That is memory with judgment in it, not just storage.

One more, late and worth the rework: the retrieval layer was quietly making the
generation layer's decisions. When a question matched weakly, `coverage_note` returned
"say so rather than inferring an answer from these passages" — a retrieval tool
instructing an LLM to decline, based on information it does not have. A follow-up like
"how long is it" scores near zero because it shares no words with its answer, but the
passages contain the runtime and the agent knows what "it" refers to. Autorag never can.
Now it reports signals — match strength, which query terms are absent, whether the query
leans on an unresolved reference — and always returns the passages. The agent judges.

And the tool surface is evaluated, not just asserted. `evals/` holds eleven questions
over a fixed seed corpus, each answerable only by calling the tools, and the run in
`evals/RESULTS.md` scores 11/11 — but the useful output was the five defects it found on
the way: a field an agent needed that only existed in another tool's prose, a recovery
tool named in a message but missing from `suggested_next_tool`, a description promising a
dry run where the runtime returns an error, and a conflict flag claiming the figures
"differ" when all it had measured was that they were not the same set. Every one is a
description bug, which is the category this surface lives or dies on.

## What we learned

Every layer should do only what it is actually capable of, and say so.

Screening nominates, it never rules: embedding distance can establish that two passages
are about the same subject, never that they disagree — so the heuristic shortlists, the
agent adjudicates, the human decides. Retrieval reports, it never instructs: it can
measure how well a passage matches some words, never whether a question is answerable —
so it hands over passages and signals, and the agent decides. Both are the same lesson
learned twice, and in both cases the honest version turned out to be the more useful
one.

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

**Tested surface.** Chrome 151 with `--enable-features=WebMCP`, native and polyfilled,
on both the dev server and the production static export, and end-to-end through an MCP
bridge rather than only from page script. We have not tested other WebMCP hosts and make
no claim about them.

**How does it use WebMCP?**
14 tools registered imperatively on `document.modelContext`, plus one derived
declaratively from an annotated HTML `<form>` — 15 in `getTools()`, which is where the
page's own tool-count badge reads from rather than counting its own registrations. Tool groups are registered and retracted
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
