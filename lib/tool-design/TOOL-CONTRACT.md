# TOOL-CONTRACT — Autorag's 14 tools

**Written before the implementation, deliberately.** `autorag-build-plan.md` §5:
*the schemas are the product being judged.* `amendments.md` A5.2 is blunter — with
the analysis tools deferred, the quality of this surface is where the submission is
won or lost.

## Rules every tool follows

1. **Naming:** `autorag_{verb}_{noun}`, snake_case, no dashes. Dashes broke tool
   compilation in NodeFlow.
2. **`execute` takes exactly one argument.** See `lib/webmcp/API-DELTA.md` D3 — verified
   at runtime on native Chrome and the polyfill. There is no second options argument.
3. **Every field carries a `description`.** A field an agent must guess at is a bug.
4. **`readOnlyHint` is accurate.** It is the only signal an agent has about whether a
   call is safe to retry or speculate with.
5. **Errors are structured**, never thrown strings — `{ok:false, error:{code, message,
   suggested_next_tool}}`. See `src/webmcp/errors.ts`.
6. **Every list tool paginates** with `{items, has_more, next_offset, total_count}`,
   default `limit` 20, max 100.
7. **Every retrieval result carries provenance** — source URL, title, ingest date.
   This is the thing pasting into context cannot give you.

## Success envelope

```jsonc
{ "ok": true, ...payload }
```

## Error codes

| Code | Meaning | `suggested_next_tool` |
|---|---|---|
| `EMPTY_CORPUS` | Nothing approved yet | `autorag_ingest_passage` |
| `NOTHING_PENDING` | Review queue empty | `autorag_get_stats` |
| `NOT_FOUND` | Unknown id | `autorag_list_sources` |
| `INVALID_INPUT` | Failed schema/semantic validation | — |
| `DUPLICATE` | Passage already indexed | `autorag_check_conflicts` |
| `MODEL_NOT_READY` | Embedding model still warming | `autorag_get_stats` |
| `INTERNAL` | Unexpected throw | — |

---

# Ingestion

## `autorag_ingest_passage` — `readOnlyHint: false`

Chunk, embed, screen, and **stage** a passage. Does **not** add it to the searchable
corpus; a human approves it first. Returns staged ids and any conflict flags.

```jsonc
{
  "type": "object",
  "properties": {
    "text":       { "type": "string", "description": "The passage to remember, as plain text. Send the meaningful body only — strip navigation, ads, and cookie banners. 50–20000 characters." },
    "source_url": { "type": "string", "description": "Canonical URL the text came from. Used for provenance and deduplication, so prefer the permalink over a search or redirect URL." },
    "title":      { "type": "string", "description": "Human-readable title of the source, shown to the human reviewing this passage." },
    "tags":       { "type": "array", "items": { "type": "string" }, "description": "Optional lowercase topic labels for later filtering, e.g. [\"pricing\",\"2026\"]." },
    "published_at": { "type": "string", "description": "Optional ISO-8601 date the source was published. Supply it when known — staleness detection is much weaker without it." }
  },
  "required": ["text", "source_url", "title"]
}
```

Returns `{ok, staged_chunk_ids, chunk_count, conflicts[], requires_human_approval: true, message}`.

**`requires_human_approval` is always `true`.** It exists so the agent states plainly
that the passage is not yet retrievable, rather than implying success.

## `autorag_check_conflicts` — `readOnlyHint: true`

Dry run. Screens a passage against the existing corpus **without staging anything**.
Use before ingesting when unsure whether material is already known.

Input: `text` (required), `source_url` (optional, improves duplicate detection).
Returns `{ok, would_create_chunks, conflicts[], recommendation}` where
`recommendation` is one of `ingest` | `skip_duplicate` | `ingest_and_review`.

## `autorag_list_pending` — `readOnlyHint: true`

The review queue. **Poll this after ingesting** to see whether the human has decided.

Input: `limit` (default 20, max 100), `offset`, `only_conflicted` (boolean).
Returns a `Page` of `{chunk_id, text_preview, source, conflicts[], staged_at}`.

## `autorag_approve_pending` / `autorag_reject_pending` — `readOnlyHint: false`

Commit or discard staged chunks. **Normally the human drives these from the UI.** An
agent should call them only when explicitly told to by the human in conversation.

`autorag_reject_pending` requires a `reason`, which is retained and returned by future
`autorag_check_conflicts` calls so the same bad source is not re-proposed.

## `autorag_adjudicate_conflict` — `readOnlyHint: false`

The agent-in-the-loop half of D4. `screen.ts` only *nominates* conflicting pairs by
embedding distance and date skew; it never rules. This tool hands a flagged pair back
to the calling agent for a verdict, which is written onto the pending item for the
human to see.

```jsonc
{
  "type": "object",
  "properties": {
    "chunk_id":  { "type": "string", "description": "Pending chunk that was flagged, from autorag_list_pending." },
    "against_chunk_id": { "type": "string", "description": "The already-approved chunk it was flagged against." },
    "ruling":    { "type": "string", "enum": ["keep_new","keep_existing","keep_both","unresolved"],
                   "description": "keep_new: the new passage supersedes the old. keep_existing: the old one is still correct. keep_both: they do not actually conflict. unresolved: you cannot tell from the text alone." },
    "reasoning": { "type": "string", "description": "One or two sentences a human will read while deciding. Cite the specific claims that conflict." }
  },
  "required": ["chunk_id","against_chunk_id","ruling","reasoning"]
}
```

The verdict is **advisory**. It annotates the queue; it does not approve anything.

---

# Retrieval

## `autorag_search` — `readOnlyHint: true`

Semantic search over **approved** chunks only. Never returns pending or rejected material.

Input: `query` (required), `k` (default 5, max 20), `tags`, `include_stale` (default
false). Returns a `Page` of `{chunk_id, text, score, source:{url,title,ingested_at,stale}}`.

## `autorag_answer_with_sources` — `readOnlyHint: true`

The centerpiece. Returns a retrieval **bundle** for a question — chunks plus the
provenance needed to cite them, plus a confidence signal.

Input: `question` (required), `k` (default 6, max 20).
Returns `{ok, question, passages[], sources[], confidence, coverage_note}`.

`confidence` is `high` | `medium` | `low`, derived from top-score and score spread.
`coverage_note` says in plain language what the corpus does *not* cover, so the agent
can decline rather than confabulate. **This tool does not generate an answer** —
Autorag has no LLM. The calling agent writes the answer from these passages and cites
`sources`.

## `autorag_explain_retrieval` — `readOnlyHint: true`

Why those chunks won. Returns per-candidate raw score, staleness demotion applied,
final score, and the near-misses that placed just outside `k`. No UI equivalent —
this exists only for agents, which is the point.

---

# Corpus management

## `autorag_list_sources` — `readOnlyHint: true`

Paginated sources with chunk counts, ingest dates, and stale flags.

## `autorag_get_stats` — `readOnlyHint: true`

`{chunk_count, approved, pending, rejected, source_count, oldest_ingest, newest_ingest,
conflict_count, embedding_model, model_ready}`.

Cheap orientation call. `model_ready: false` means embeddings are still warming and
ingest/search will return `MODEL_NOT_READY`.

## `autorag_mark_stale` — `readOnlyHint: false`

Flags a source as outdated **without deleting it**. Its chunks stay retrievable but are
demoted in ranking and returned with `stale: true`. Requires a `reason`.

Prefer this over `autorag_forget_source` — the record of what was once believed is
part of the memory.

## `autorag_forget_source` — `readOnlyHint: false`, **destructive**

Permanently removes a source and all its chunks. Irreversible.

Requires `confirm: true` alongside `source_id`; omitting it returns `INVALID_INPUT`
explaining that confirmation is required. Since `requestUserInteraction` does not
exist (API-DELTA D4), this explicit confirmation field plus the UI's own confirm step
is the whole guard.

---

## `autorag_check_coverage` — `readOnlyHint: true`  ✅ shipped

The one analysis tool `amendments.md` A3 endorsed, and only because there is real
computation behind it: retrieval plus an explicit score threshold.

Input: `question` (required), `threshold` (default 0.45).
Returns `{ok, verdict, threshold, top_score, supporting_passages[], recommendation}`
where `verdict` is `covered` | `partial` | `not_covered`.

Deliberately **not** called gap analysis, in the description as well as here. It
reports what the corpus *does* support for a given question; it cannot enumerate what
is missing. Overclaiming it would be worse than not shipping it.

---

# Declarative API

`autorag_submit_passage_form` is not registered in JavaScript at all — the browser
derives it from an annotated `<form>` in `components/DeclarativeIngestForm.tsx`.
Same capability as `autorag_ingest_passage`, second registration API, one repo.
Verified present in `getTools()` on native Chrome 151.

---

# Still deferred — do not implement

`find_gaps` and `get_frontier` stay out unless there is real computation behind them
(coverage against a user-supplied topic outline, or sparse-region detection over the
embedding space). A thin wrapper over `search` is worse than not shipping it.

---

# Dynamic registration

| Group | Registered when |
|---|---|
| `always` | `autorag_ingest_passage`, `autorag_check_conflicts`, `autorag_get_stats`, `autorag_list_sources` |
| `approval` | only while the pending queue is non-empty |
| `retrieval` | only while the approved corpus is non-empty |

Each group owns an `AbortController`; state changes call `abort()` and re-register.
`unregisterTool` does not exist (API-DELTA D2). This keeps the surface honest: an
agent is never offered `autorag_search` against an empty index.
