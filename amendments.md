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

---

## A7. The extension, and what it does to A2 (2026-09-01)

`autorag-build-plan.md` **AD-5** supersedes AD-3: there is now a browser extension, and
it is the product. The web app remains as the deployed tool host, because tools published
by an extension cannot be seen by an agent-browser that will not run extensions.

**A2 needs one correction and gains one claim.**

The correction: *"the page is the memory store"* was true of the web app and is not true
of the extension, where the corpus lives in extension storage and outlives every tab. The
durable version of that claim is **the browser is the memory store** — no server, no
account, no sync.

The new claim, and the strongest one available: **the memory travels.** Four tools are
registered on `document.modelContext` of every page you visit — measured on sites that
have no WebMCP of their own, `wikipedia.org` and `example.com` among them. A vector
database sits behind an API something must be built against; this offers itself to any
agent on any page, with no integration and no key. That is the part which is not
commodity, and it is WebMCP doing it.

A2's caution still applies: recheck the Devpost gallery before writing the final
description.

**A5.1 (cold start) now has a second face.** The 25MB model download happens inside the
extension, where there is no page to show a progress bar on. The side panel reports model
phase and percentage, and an activity feed shows chunking, embedding and screening as they
happen — an empty corpus with no visible work looks identical to a broken tool.

## A8 — PDFs are read in Autorag's own viewer, not Chrome's

Highlighting in a Chrome-rendered PDF cannot work, and the reason is structural rather
than a permission we failed to ask for: PDFium draws the text and puts it in no DOM, so
`getSelection()` returns `''` even inside the viewer's own frame read over CDP (API-DELTA
**D19**). Every route that keeps Chrome's viewer is a workaround — the clipboard, a paste
box, extracting the bytes to recover the words but never the highlight.

So the extension ships a reader (`extension/src/reader/`) that renders the PDF with pdf.js.
This is not a PDF feature; it is the **removal of a PDF exception**. Once the text layer is
ordinary DOM, `keep-ui.ts` works there unchanged and there is no PDF branch anywhere in the
capture path.

**Opt-in per document, deliberately.** Chrome's viewer stays the default and nothing is
redirected, so printing, signing and form-filling still work where they always did. The
cost is one click per document — not per highlight, which is what the clipboard route would
have cost.

The honest price: ~5.9MB of vendored pdf.js (worker, cmaps, standard fonts, wasm decoders,
ICC profile), and `connect-src` widened to `https: http:` so the reader can fetch the PDF
it is pointed at. The latter is not new capability — `host_permissions` was already
`<all_urls>` — it removes a CSP block on capability the extension already had.

## A9 — Autorag answers for itself

The product could find passages and never answer with them. It handed results to whatever
agent was attached, which in practice meant a coding tool had to be running for Autorag's
own loop to close. Retrieval was ours; the answer was always borrowed. A memory that needs
someone else's chat window to be useful is half a product, and the person using it said so.

So the extension now has a generative half: **Recall retrieves locally, then a model writes
the answer from the retrieved passages.** No MCP client, no relay, no bridge tab, no
Claude Code.

**What did not change, deliberately.** The index stays local — MiniLM in the offscreen
document, vectors in IndexedDB, hybrid ranking in `src/rag/search.ts`. A hosted vector
database was offered and declined: it would add a key, a network hop and a bill in exchange
for capability that already works offline, and would trade away the claim that matters.

**What did change, and it is the one thing worth saying out loud.** With a key set, the
question and the passages retrieved for it leave the device. That is the first time
anything in Autorag has. The header line tracks it rather than repeating "Nothing is
uploaded" once it stops being true, and with no key the product is exactly what it was.

**Grounded only.** The model answers from the supplied passages, cites each claim, and says
what is missing rather than filling the gap from training. Same rule the corpus already
holds itself to — `bench` scores "no overclaim" and "no withhold" as separate failures. An
answer you cannot check against the passage it came from destroys the property that made
keeping it worthwhile. `ext:check` asserts both halves: that the retrieved passages are
what goes up, and that the system prompt forbids anything else.

## A10 — Memory is no longer stuck on one laptop

The corpus lived in one browser profile on one machine. That was the last thing standing
between Autorag and being usable: *"if one person has multiple laptops with the same browser
account, naturally he wouldn't want to switch to another laptop for the sake of having
access to certain data."*

Cloud memory is now a **mode**. Local stays the default — free, offline, nothing leaves the
device. Cloud is opt-in against the user's own Supabase project, with their own bill, the
same bargain as the answering key.

**It mirrors rather than relocates.** IndexedDB is still the only thing anything reads from;
`src/rag/sync.ts` pushes rows up and pulls rows down. Retrieval never moves, so there is one
ranker, one benchmark and offline still works. Moving search server-side would mean
re-implementing hybrid fusion in SQL — `ts_rank_cd` is not BM25 — and a second ranker that
quietly disagrees with the first is worse than no second ranker.

**Postgres rather than a vector service**, because our ranking needs a dense *and* a lexical
half, and most vector databases sell only the first. `pgvector` and `tsvector` in one system;
the columns exist now so server-side ranking can be added later without a migration.

**The anon key in client code is safe here, and that is why Supabase.** It grants nothing
alone; row-level security scopes every row to `auth.uid()`. The credential that matters is a
per-user JWT.

**Tombstones, because a deletion is the one change that leaves nothing to sync.** Forget a
source on one laptop and a naive pull hands it straight back — and a resurrection looks
exactly like a sync that worked. `pnpm ext:sync` runs two profiles and asserts it stays
deleted, which is the only way anyone would notice.

The relay was removed in the same pass — see the note in `offscreen/main.ts`. The seven
WebMCP tools are untouched; only the desktop-MCP path is gone.

## A11 — Remember: multi-turn as a mode, not a default

Ask was single-shot. Multi-turn was small to build; the reason to be careful was never
feasibility but **grounding erosion** — by turn four a model can answer from its own earlier
replies rather than from retrieved passages, and those replies are its prose, not the
person's sources. A claim launders through a previous answer and loses its citation, which
is the one property the whole design exists to protect.

So it is a **checkbox, off by default**, and turning it on turns on the two things that make
it safe:

- **The follow-up is rewritten before retrieval.** "What about the second one?" embeds to
  nothing useful; without this a conversation degrades into searching on pronouns. The
  rewrite runs on Haiku regardless of the chosen model — a mechanical restatement should not
  cost Opus rates — and falls back to the raw question rather than failing the turn.
- **Prior turns are conversation; the passages ride on the current turn alone.** The system
  prompt says so explicitly, and `ext:check` asserts the message array has that shape.

Off by default because the failure mode of "on" is quiet rather than loud. The tradeoff is
real and it belongs to the person — same principle as local-versus-cloud memory and the
model picker — so the panel shows the turn count and running token total beside the
checkbox, with Clear.

## A12 — An image is evidence, not just a caption

Images were kept by their description and answered from their description. That conflated
two different jobs, and the person using it caught the conflation: *"I say a word and the
image has the definition. I ask what the word means and in order to do that you gotta look
at the image?"*

Exactly so. **The description is the retrieval key** — it is what makes an image findable at
all, since embeddings are text-only and MiniLM has never seen a pixel. **The pixels are the
evidence** — where the answer actually lives. A card captioned "definition of X" is enough
to find and useless to answer from.

So a retrieved passage tagged `image` now goes to the model as an image block, before its
text: the evidence first, then how it was filed. The system prompt says what the image
shows counts as coming from the passage, and warns that the text beside it may be a
filename rather than a description — which is the common case (a Brave image result files
itself as `gemini-2-5-flash-thinking-level-not-supported-en`).

Without this, the model would answer confidently from the caption. That is the worst
failure mode this project has: it reads like a citation and is not one.

**Inlined as base64 rather than passed as a URL.** The API can fetch a URL itself, but
images worth keeping sit behind CDNs with hotlink protection and expiring signed links.
Anthropic's fetcher is refused where the extension is not, because the extension holds host
permissions and the browser's cookies. Every failure path returns null instead of throwing:
an unreachable picture costs you the picture, not the answer — and that is its own check,
because it is the branch that will actually run in the wild.

**Related fix in the same pass.** `describeImage()` was appending the image URL and page URL
into the *indexed* text. On an article, mild; on a search-results page, fatal — a CDN link
is ~250 characters of base64, several times the caption, so the vector was mostly hash and
BM25 got tokens no one would ever type. Provenance moved to metadata: the image URL is
already the chunk's source, the page became a tag, and only the page title stays in the
text, because "the diagram from the page about adaptive thinking" is a real query.

## A13 — A saved passage can be fixed or dropped, one at a time

Curation stopped at the review queue. Once a passage was approved the only correction
available was `forget`, which removes the *entire source* — every other passage kept from
that page thrown away to fix or remove one. In practice that means keeping things you have
already decided are wrong, which is the opposite of what a curated memory is for.

Two changes, and the second is the interesting one:

**Editing an approved passage returns it to the review queue.** Silently rewriting approved
text would be worse than refusing: approval means a person read it and vouched for it, and
the corpus would end up holding sentences nobody agreed to. So the edit is allowed and the
vouching is withdrawn — re-approve and you have vouched for what it now says. Adding a note
does not re-open it; a note annotates without altering what was approved.

**`decideChunks` now permits `approved -> rejected`.** It previously moved pending chunks
only. `rejected` remains terminal in both directions, because a discarded passage's text is
what future screening matches against — resurrecting or editing one would quietly change
what gets flagged later.

Both live on Recall results rather than in a separate corpus browser, because that is where
you *notice*: a passage that dragged in a cookie banner or clipped a sentence looks fine
until it comes back in a search.

**Two probe bugs found while checking this, both of which passed for the wrong reason
first.** A discard test that reused an already-approved chunk (where `reject` was a silent
no-op, so nothing was ever rejected), and a sibling-survival test whose two paragraphs
chunked into one passage — so "the rest of the source survived" was unmeasurable. A check
that passes without exercising its claim is worse than no check.

