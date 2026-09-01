# Eval run — 2026-09-01, through the MCP bridge

Every question in `autorag_eval.xml` was answered by calling Autorag's tools over
`@mcp-b/chrome-devtools-mcp@2.3.2` against `http://localhost:3111` on Chrome 151, with
the corpus seeded from `seed-corpus.json`. Nothing was read out of the source files to
answer a question; every figure below came back through `call_webmcp_tool`.

**11/11 match the answer key.** Five description or payload defects were found and
fixed in the process — which is the point of the exercise, not a side effect of it.

A second run against the build plan's per-phase acceptance gates followed; it found that
the declarative `<form>` tool had never actually worked. See *Second run* below.

## Standing caveat: this is not a blind agent run

The caller had the repo in context. That rules out the single most valuable failure
mode this eval exists to catch: an agent choosing the *wrong tool* because two
descriptions overlap. What it does establish is everything downstream of the choice —
that each tool's arguments are guessable from its schema, that its result answers the
question asked, and that the whole surface works end to end through the bridge an agent
actually connects over.

Closing the remaining gap needs an agent that has never seen this repo, pointed at the
page with nothing but the tool descriptions. See `HANDOFF.md` §5.

## Results

| # | Question | Tools used | Result |
|---|---|---|---|
| 1 | Source and stale counts | `get_stats` | ✅ 4 sources, 1 stale |
| 2 | Embedding model, dimensions, readiness | `get_stats` | ✅ after fix — see F1 |
| 3 | Runtime of Dune: Part Two | `answer_with_sources` | ✅ 166, confidence high |
| 4 | The two disagreeing critic scores | `search` | ✅ 92 and 79 |
| 5 | Contradiction flagged among *pending* material | `ingest_passage` ×4 | ✅ flagged on the 4th, against a staged chunk |
| 6 | Coverage of "capital of Mongolia" | `check_coverage` | ✅ `not_covered`, top score 0.038 |
| 7 | Which source is stale and why | `list_sources` | ✅ JustWatch, reason returned verbatim |
| 8 | Deleting without `confirm` | `forget_source` | ✅ `INVALID_INPUT`, 1 passage named |
| 9 | Recovery tool named by the error | `forget_source` | ✅ after fix — see F2 |
| 10 | Candidates and staleness demotion | `explain_retrieval` | ✅ 4 considered, demotion on JustWatch |
| 11 | Empty filtered search | `search` (bad tag) | ✅ "Retry with include_stale: true" |

Also exercised, outside the question set: `check_conflicts`, `list_pending`,
`approve_pending`, `reject_pending`, `adjudicate_conflict`, `mark_stale`,
`list_sources`, and the rejection-memory round trip — proposing rejected material again
returns the human's own recorded reason (verified, F5 below).

## Defects found

**F1 — `get_stats` reported the model but not its dimensions.** Q2 was answerable only
by calling `explain_retrieval` and reading "384-dimensional" out of a prose note in its
`note` field. An agent asked about the memory's configuration will call the tool whose
description says it summarizes the memory's configuration. Added
`embedding_dimensions`, and the description now says the field is there.

**F2 — `forget_source` named its recovery tool only in prose.** The refusal message
said "Consider autorag_mark_stale instead", but `suggested_next_tool` was absent:
`INVALID_INPUT` had no default suggestion and there was no way to set one per call.
Agents route on the field, not the sentence. `fail()` now takes an optional override and
the refusal uses it.

**F3 — `forget_source`'s description promised a dry run and delivered an error.** It
read "call it once without confirm to see what would be removed", but that path returns
`ok: false`. An agent that believes the description will report a failed deletion and
stop. The description now says the preview *is* an `INVALID_INPUT` error and to read it
as such.

**F4 — the contradiction detail claimed more than the heuristic measured.** It said "the
figures differ (84, 300, 2024, 2021, 1965)" — but that list is a symmetric difference
over numeric tokens, so a release year present in one passage and absent from the other
appears identically to two disagreeing review scores. Screening cannot tell those apart;
saying "differ" asserts it can. It now reports the two sides separately — "this passage
has 79; that one has 92, 500, 95" — and states that judging whether it is a disagreement
means reading the claims around the numbers. Same rule the screening and retrieval
layers already follow: a layer says only what it is in a position to know.

**F5 — cosmetic string defects in text humans read.** `summarizeConflicts` returned "1
contradiction" with no terminal period, so the ingest message ran two sentences
together ("...1 contradiction Poll autorag_list_pending..."), and it never pluralized
("3 contradiction"). The rejection-memory detail ended `..."`.` with doubled
punctuation. All three fixed.

One further defect surfaced while running this and is written up separately as
`API-DELTA.md` D13: an `AbortError` from `registerTool` was reaching the page as an
uncaught rejection on every load.

## Second run — 2026-09-01, the acceptance gates

Re-run from an empty memory to check the build plan's own per-phase gates rather than
the question set. Everything below was driven through `call_webmcp_tool`; the UI was
touched only where the gate is about the UI.

| Gate | Result |
|---|---|
| **Phase 1** — paste → search → correct chunk | ✅ and survives reload: 4 chunks, 4 sources intact after a full page load |
| **Phase 2** — agent ingests and retrieves with no UI interaction | ✅ ingest ×4, adjudicate, reject, approve ×3, search — zero clicks |
| **Phase 3** — a bad source visibly gets caught and rejected | ✅ see below |
| **Phase 4** — corpus management, declarative form | ⚠️ management ✅; the declarative form was **broken** — see D14 |
| **§7 demo arc** — wrong → right with provenance | ✅ see below |

**The demo arc, measured.** With an empty memory, `autorag_answer_with_sources` does not
exist — the retrieval group is not registered, so the agent is not offered a search tool
against nothing. Four passages ingested; the fourth, an undated blog claiming a free
Netflix stream, was flagged against the JustWatch listing, ruled on by the agent, and
rejected with a reason. The other three were approved. The same question then returned
Max and 92 percent with source URLs and ingest timestamps, and the rejected claim
appears nowhere in the answer. Re-proposing the blog returns
`recommendation: "skip_duplicate"` and the human's own rejection sentence.

**"Nothing leaves the device", measured.** After the full cycle,
`performance.getEntriesByType('resource')` reports 28 requests, **0 of them
cross-origin**. On a cold profile there is exactly one external origin, the Hugging Face
CDN, for the one-time model download.

### What this run found

**The declarative `<form>` tool did not work.** It listed correctly in `getTools()` and
had been recorded as verified on that basis. Calling it hung for 120 seconds and staged
nothing. Three causes, all now fixed, written up as `API-DELTA.md` D14 — and the last of
them was D12 repeating itself on a path that had never been exercised.

Three more, from the same session:

- The form-derived tool bypasses `registerGroup`, so nothing logged it. Three agent
  calls landed while the activity panel read "No agent calls yet."
- `event.currentTarget` is null after the first `await`, so the handler's own
  `form.reset()` threw into its catch block and a **successful** human submission
  rendered an error string.
- The numeric-token regex matched the `1,` in "March 1, 2024", so conflict details read
  "this passage has 1,".

### One honest limit, quantified

Screening caught **one of the two** real disagreements in that bad blog post. It flagged
the streaming conflict against JustWatch (cosine 0.74) but not the 79-vs-92 score
conflict against Rotten Tomatoes, which sits at **0.659** — below the `SAME_TOPIC_AT`
threshold of **0.72**, so the pair was never considered the same subject and never
nominated.

That is recall, not correctness: the design says screening nominates and never rules,
and the human still caught it. But it is a measured miss, not a hypothetical one.
Lowering `SAME_TOPIC_AT` to ~0.65 would have flagged it, at a precision cost nothing
here has measured. Left as it is deliberately, and recorded so the number is known.

## Reproducing

Follow `README.md` in this directory to seed, then drive the eleven questions through
any MCP bridge. `pnpm bench` covers retrieval quality separately and does not overlap
with this: it measures ranking, this measures the tool contract.
