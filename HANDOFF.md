# Handoff — read this first in a new session

**Autorag** is a curated retrieval memory that lives in the browser. You keep things while
you read; a human decides what stays; any agent that speaks WebMCP can search what
survived. No server, no API key, no LLM anywhere in this repo.

**Deadline:** Sep 3, 1:00pm PDT. **Branch:** `main`, 19 commits, **nothing pushed.**
**Last worked:** 2026-09-01.

---

## 0. There are two artifacts. Understand this first.

They share one engine (`src/rag/`) and have different jobs. Neither is dead code.

| | **Extension** (`extension/`) | **Web app** (`app/`, `src/webmcp/`) |
|---|---|---|
| Role | **the product** | the deployed tool host |
| Capture | highlight → Keep · `Ctrl+Shift+K` · whole-page preview | agent calls `autorag_ingest_passage`; manual form as fallback |
| Tools | 7, injected into **every page you visit** | 15, on its own page, both registration APIs |
| Agent can curate | partly — reads the queue and adjudicates; cannot approve | ✓ — queue, adjudication, staleness, deletion |
| Corpus | extension storage, outlives every tab | IndexedDB on its own origin |
| Reached by | a desktop MCP client, via `pnpm bridge` | any agent that can visit a URL |

**Why both.** Tools published by an extension are invisible to an agent-browser that
cannot run extensions — ChatGPT's in-app browser among them. The web app is the artifact
such an agent can visit. See `autorag-build-plan.md` **AD-5**.

The two corpora are separate. Accepted limitation, not an oversight: different origins,
and IndexedDB does not cross origins.

---

## 1. Sixty-second orientation

```bash
cd /home/dogeyboy19/Desktop/gtmp/AutoRag
pnpm install

# The product
pnpm ext                  # build the extension
#   brave://extensions → Developer mode → Load unpacked → extension/dist
pnpm ext:check            # 19/19 against a real Brave, throwaway profile

# The desktop bridge
pnpm bridge               # serves http://localhost:3210 — leave the tab open
pnpm ext:relay            # 6/6 — a real MCP client searching the memory

# The web app
pnpm dev                  # http://localhost:3111
pnpm bench                # 21/21, 3/3, 25/25
pnpm loop                 # 15/15 through WebMCP on Brave
```

Then read **`extension/README.md`** (install and use) → **`lib/webmcp/API-DELTA.md`**
(18 findings, every one reproduced by running it) →
**`lib/tool-design/TOOL-CONTRACT.md`** (the web app's 15 schemas).

**Browsers.** Brave 1.94.117 (Chromium 152) and Chrome 151, both verified. Native WebMCP
needs `--enable-features=WebMCP`; **quit the browser completely first** or the flag is
silently ignored and you get a page with no tool surface and no error saying why. Without
it the `@mcp-b/global` polyfill takes over and everything still works.

---

## 2. The pivot, and why — read this before changing direction again

The build plan's **AD-3** said, verbatim, *"No browser extension."* Its idea of seamless
was that **the agent** does the gathering, so a person never pastes anything. That is
elegant, and it has one fatal problem: it requires an agent to be present before the
product does anything at all. No WebMCP consumer ships to ordinary users yet — so the only
path actually available to a person was the manual ingest form. Pasting a URL into a
dashboard is worse than the problem it set out to solve, and indistinguishable from an LLM
wired to a vector database.

So AD-3 is superseded by **AD-5**: the extension is the product, capture costs one gesture
where you already are, and WebMCP's role moves from *the only way in* to *the reason the
memory travels*.

This was not written down while it happened, and four planning documents ended up
describing a project that no longer existed. That is why this file was rewritten. **If you
change direction again, amend `autorag-build-plan.md` in the same commit.**

---

## 3. What is verified

Every row is a command that produces the number, not an assertion.

| Surface | Command | Result |
|---|---|---|
| Retrieval quality | `pnpm bench` | top-1 21/21 · no overclaim 3/3 · no withhold 25/25 |
| Web app tool surface | `pnpm loop` | 15/15 on Brave; also verified on Chrome 151 |
| Tool contract | `evals/RESULTS.md` | 11/11, five defects found and fixed by running it |
| Extension end to end | `pnpm ext:check` | 19/19 |
| **Desktop agent** | `pnpm bridge` + `pnpm ext:relay` | **6/6** |
| Extension origins | `node probes/extension-origin-check.mjs` | every extension context rejects; a web page works |

`pnpm ext:check` covers the claims that matter: a third-party page gains a WebMCP surface
it never had, the seven memory tools appear on it, a highlight-and-click actually stores
text, whole-page capture previews before storing, the corpus can be managed,
keep → approve → recall returns the passage with its source, an agent reads the queue and
rules on a flagged pair, that ruling reaches the queue the human reads, and no approval
tool is reachable from the page.

---

## 4. The findings that shaped the design

All 18 in `lib/webmcp/API-DELTA.md` with reproductions. The five that cost the most:

**D12 — MCP bridges forward only a `CallToolResult` envelope.** `executeTool()` from page
script serializes anything, so bare objects tested fine while **all 15 tools returned
empty to every agent**. Fixed centrally in `toCallToolResult()`.

**D14 — a declarative `<form>` tool is discoverable long before it is callable.** It
listed correctly in `getTools()` for the whole build and was recorded as verified on that
basis. Calling it hung for 120s and stored nothing. Needed `toolautosubmit` (spelled
`toolautosubmit=""` or React drops it) *and* `SubmitEvent.respondWith()` *and* D12's
envelope.

**D15 — resetting a form cancels the invocation it is answering.** The handler cleared its
own fields on success, which on Chromium 152 kills the agent's pending call *after* the
work commits. Chrome 151 passed this; Brave caught it.

**D16 + D17 — the pair that closed the door on each other, then opened one.** The relay
cannot bridge an `https://` page (`ws://127.0.0.1` dies mid-handshake). Extension origins
cannot register tools at all — native gives the reason the polyfill hides behind an empty
`SecurityError`: `document.modelContext cannot be used when document.domain is enabled`.
The way through was their *intersection*: an ordinary page served over plain http on
localhost is the one context that is neither. That is `extension/connector/`.

---

## 5. Architecture rules — do not regress these

1. **Screening nominates; it never rules.** Embedding distance establishes two passages are
   about the same subject, never that they disagree. `screen.ts` shortlists → the agent
   adjudicates → the human decides.
2. **Retrieval reports; it never instructs.** Autorag has no LLM and cannot see the
   caller's conversation, so it must not decide a question is unanswerable. Passages come
   back **always**, plus `match_signals`.
3. **Never say "train."** Nothing is trained. Say ingest, index, memory, corpus.
4. **The review queue is steering, not security** (`amendments.md` A1, A4).
5. **A description describes what the runtime does, not what you wish it did.** Three eval
   defects were this exact shape. Agents believe descriptions.
6. **A tool is not verified until a call through the consumer's path returns the right
   answer AND leaves the right state behind.** Both halves. D12, D14, and one weak check in
   `relay-check.mjs` that went green against an empty memory were all this mistake.

---

## 6. What is left

**App-side, in priority order:**

- [x] **Agents have the curation loop on the extension** (2026-09-01). `autorag_list_pending`,
      `autorag_adjudicate_conflict` and `autorag_list_sources` now sit on every page beside
      the four capture tools, with `adjudicate` wired through `protocol.ts` and
      `offscreen/main.ts` onto the existing `annotateConflict`. Three things worth knowing
      before touching it: `listPending` carries the *opposing passage's text*, not just its
      id, because an adjudicator that cannot read both passages cannot do the job; the panel
      renders `agent_verdict` as its own block under the flag, since a verdict that lands
      nowhere a human reads is D12 wearing a different hat; and **approve and reject are
      deliberately absent** from the page surface — `ext:check` asserts their absence, so a
      later "completeness" pass cannot quietly add them.
- [ ] Strip `page_heading`, the demo tool `@mcp-b/global` registers on every page.
- [ ] Verify the extension corpus survives a full browser restart. Never explicitly
      tested — `ext:check` uses a throwaway profile each run.
- [ ] The blind-agent test (§7). Highest-value engineering left.

**Docs and submission:**

- [ ] Rewrite `lib/demo/DEMO-SCRIPT.md` for the extension as lead: highlight on a real
      site → conflict in the review queue → reject on camera → recall with provenance →
      the agent calling the tools through chrome-devtools-mcp.
- [ ] `SUBMISSION.md` — move the extension to the headline; it currently leads with the
      web app.

**Blocked on the user.** `HUMAN-TASKS.md` is now a feature-by-feature test plan rather
than a task list — twelve features, each with what it is meant to do, what to do, and what
"working" looks like. Two of its checks are the ones no automated run can reach:

- [ ] Use the extension on real pages and report anything that costs more than one gesture,
      happens silently, or leaves you unsure whether it worked.
- [ ] Confirm the corpus survives a full browser restart (§7 below; every probe uses a
      throwaway profile, so only real use tests this).

Publishing, the video and the Devpost submission were dropped from that file by the user's
instruction — *"all that matters now is ensuring the application works."* Push is still
unrun and still the user's call: `gh repo create autorag --public --source=. --remote=origin --push`.

**Deploy is NOT on the list.** It was justified solely by ChatGPT's in-app browser being
the only shipping WebMCP consumer that can visit a URL but cannot run an extension. The
demo agent is chrome-devtools-mcp, which reaches `localhost:3111` fine, so the deploy buys
nothing. Revisit only if Devpost demands a live URL — unverified; `SUBMISSION.md` has a
"Live URL" field written on that assumption.

**Deferred by decision — do not "fix":** ChatGPT's in-app browser is untested and
unclaimed; the token benchmark is cut; `find_gaps` stays out unless there is real
computation behind it.

---

## 7. The one test nobody has run

Every test either names a tool directly or is driven by someone who already knows what the
descriptions mean. So this is still unproven:

> An agent, seeing only the tool descriptions, picks the right tool with the right
> arguments.

MCP exists so a model can choose the appropriate tool, which makes this the claim the
whole thing rests on.

**How:** a fresh agent session with no context, pointed at a page with the extension
installed, told only *"save something useful from this page."* Watch which tool it reaches
for and whether it invents arguments. A wrong choice is a **description bug** — fix the
wording in `extension/src/content/webmcp.ts`.

---

## 8. Gotchas that look like bugs

| Symptom | Reality |
|---|---|
| Extension: model never becomes ready | Brave Shields blocking the one-time `huggingface.co` download. Drop once, reload, restore. |
| Extension: silently dead after a dependency change | MV3 forbids WASM without `'wasm-unsafe-eval'`, and transformers.js pulls its ONNX backend from a CDN the same CSP blocks. Both handled; the runtime is vendored into `dist/ort/`. The symptom lies: weights reach 100%, then "no available backend found". |
| `page_heading` on every page | `@mcp-b/global` registers it. Not ours. |
| Web app: only 5 tools at first | Correct. Approval tools appear when something is staged, retrieval tools when something is approved. |
| `call_webmcp_tool` returns "no output" | Results are not reaching agents — D12. |
| A tool call hangs to a 120s timeout | Nothing is submitting — D14. |
| Returns fine but the counts did not move | It answered without doing the work. |
| A one-word search scores 0.2 and is right | Normal. Trust `confidence`, not the number. |
| Conflicts list years among the figures | It over-flags on purpose, and claims only that the two passages carry numbers the other does not. |
| Screening missed a real conflict | Known. One measured miss scored 0.659 against `SAME_TOPIC_AT` 0.72. It nominates; you rule. |
| `chrome-devtools-mcp` sees no extension tools | That harness did not inject our content scripts. Use `pnpm ext:check` or `pnpm ext:relay`. |

---

## 9. Repo map

```
extension/          THE PRODUCT
  src/content/        selection.ts (capture + bridge) · webmcp.ts (tools on every page)
  src/offscreen/      owns the corpus and the model; survives the service worker
  src/sidepanel/      review queue · recall · manage corpus · activity
  connector/          the http page the desktop bridge needs (pnpm bridge)
  README.md           install and use

src/rag/            THE ENGINE, shared by both — embed · chunk · store · search · screen
src/webmcp/         the web app's 15-tool surface
app/ components/    the web app

probes/             webmcp-loop · extension-check · relay-check · extension-origin-check
bench/              retrieval benchmark (pnpm bench)
evals/              11 QA pairs + RESULTS.md (11/11, five defects found)

lib/webmcp/API-DELTA.md        18 verified findings. Highest-value doc in the repo.
lib/tool-design/TOOL-CONTRACT.md
autorag-build-plan.md          AD-5 supersedes AD-3. Read §2 above first.
amendments.md                  A7 is current.
HUMAN-TASKS.md                 the feature-by-feature test plan for a person
MANUAL.md                      plain-language guide — written for the web app
```

---

## 10. If you change one thing, re-run these

```bash
pnpm typecheck && pnpm build && pnpm ext
pnpm ext:check                              # 19/19
pnpm bridge & pnpm ext:relay                # 6/6
pnpm dev                                    # bench and loop both drive the app
pnpm bench                                  # 21/21, 3/3, 25/25
pnpm loop                                   # 15/15
```

Run `pnpm loop` on a second browser before believing a green result: D15 was green on
Chrome and red on Brave.
