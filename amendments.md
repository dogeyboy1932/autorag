# Autorag — Amendments

Applies to `autorag-build-plan.md`. Read both.
Supersedes all earlier versions of this file.

---

## A1. Keep the review queue. Change only how it's described.

The staged-ingest queue and `requestUserInteraction` gating stay as planned.
No implementation change.

Framing change: the queue is **steering** — the human shapes what the memory
becomes. It is not a security control and should not be pitched as one.

---

## A2. What makes this non-derivative

Prior art check: browser-side RAG (transformers.js + IndexedDB + cosine) is
commodity, and MCP servers exposing `rag_ingest`/`rag_search` are commodity.
Neither is a claim you can make.

What holds up:

- **No server, no API key, no inference cost.** The calling agent is the generation
  layer; tools return chunks + provenance only. Fully client-side is literal here.
- **Persists across sessions and across agents.** The page is the memory store.
- **Provenance on every retrieval** — which source, ingested when.
- **A human-shaped corpus**, not an indiscriminate one.

Devpost gallery is unpublished; competitor submissions unknown. Recheck before
writing the final description.

---

## A3. Analysis tools — deferred, not cancelled

`find_gaps`, `check_coverage`, `get_frontier` are **not part of WebMCP.** They are
ordinary functions over your own index that you would register as tools. Naming
was mine; treat them as optional.

**Deferred to stretch.** Ship ingest, search, and management first.

If time allows, add **one** — `autorag_check_coverage` is the cheapest and most
useful: given a question, return whether the corpus can answer it, with the
supporting chunks and a confidence signal. Implement as retrieval plus a score
threshold; do not overclaim it as gap analysis.

Skip `find_gaps` unless there's a real computation behind it (coverage against a
user-supplied topic outline, or sparse-region detection over the embedding space).
A thin wrapper over `search` is worse than not shipping it.

---

## A4. Withdrawn concerns

- **Tab-switch retention** — not MVP-blocking. Tools are registered by your page,
  so the agent must be on your tab to call them regardless. Read elsewhere, return,
  deposit. Note it in Phase 0 as an observation, not a gate.
- **"Agent might not call the tools"** — true of every submission in this hackathon.
  Ambient, not specific.
- **Security/poisoning framing** — drop entirely. At most one line in the
  description justifying `requestUserInteraction` on destructive ops.

---

## A5. Real risks that remain

1. **Cold start.** ~25MB model download plus WebGPU init. Cache aggressively, warm
   on page load, ship a real loading state. Pre-warm before recording the video.
2. **Tool surface reads as thin.** With analysis tools deferred, ingest/search/manage
   must be excellent: precise schemas, per-field descriptions, correct
   `readOnlyHint`, structured errors with a suggested next tool, pagination on lists.
   This is where the submission is won or lost now.
3. **Phases 1–2 alone ship a replica.** The queue, provenance, and cross-session
   persistence are what distinguish it. Don't cut them for polish.

---

## A6. Demo

Two beats that defeat "just paste it into context":

- **Cross-session resume** — close the session, open a fresh one, memory is still there.
- **Provenance** — the answer cites which sources supported it and when they entered.

Show the queue as the human steering the corpus, not as a security checkpoint.