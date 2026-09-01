# Eval run — 2026-09-01, through the MCP bridge

Every question in `autorag_eval.xml` was answered by calling Autorag's tools over
`@mcp-b/chrome-devtools-mcp@2.3.2` against `http://localhost:3111` on Chrome 151, with
the corpus seeded from `seed-corpus.json`. Nothing was read out of the source files to
answer a question; every figure below came back through `call_webmcp_tool`.

**11/11 match the answer key.** Five description or payload defects were found and
fixed in the process — which is the point of the exercise, not a side effect of it.

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

## Reproducing

Follow `README.md` in this directory to seed, then drive the eleven questions through
any MCP bridge. `pnpm bench` covers retrieval quality separately and does not overlap
with this: it measures ranking, this measures the tool contract.
