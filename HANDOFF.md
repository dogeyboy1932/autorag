# Handoff — read this first in a new session

**Project:** Autorag — a browser-native, agent-curated retrieval memory exposed over
WebMCP. Hackathon submission, deadline **Sep 3, 1:00pm PDT**.
**Last worked:** 2026-09-01. **Branch:** `main`, 7 commits, **nothing pushed yet.**

---

## 0. Sixty-second orientation

```bash
cd /home/dogeyboy19/Desktop/gtmp/AutoRag
git log --oneline          # 7 commits, all local
pnpm install               # if node_modules is missing
pnpm dev                   # http://localhost:3111
pnpm bench                 # retrieval benchmark; must print 21/21, 3/3, 25/25
```

Then read, in order: **`MANUAL.md`** (what it is, how to test it) →
**`lib/webmcp/API-DELTA.md`** (what the browser actually does — 13 findings, all
verified by running them) → **`lib/tool-design/TOOL-CONTRACT.md`** (the 15 tool schemas).

**Chrome must be launched as** `google-chrome --enable-features=WebMCP`.
The switch `--enable-webmcp-testing` does *not* work despite the flag existing.

---

## 1. MCP servers — no restart needed any more

Two servers are registered in this project and **both are connected**:

| Server | Command | Gives you |
|---|---|---|
| `chrome-devtools` | `npx -y @mcp-b/chrome-devtools-mcp@2.3.2 --isolated` | `list_webmcp_tools`, `call_webmcp_tool`, page control |
| `webmcp-docs` | `https://docs.mcp-b.ai/mcp` | current WebMCP docs |

Verify with `claude mcp list`. If the tools are missing from your session, **restart
Claude Code** — MCP servers load at session start, so a server added mid-session stays
invisible until then. That cost this project a day of testing through the wrong path
(see §3, D12).

> ⚠️ **Pin the version.** `@mcp-b/chrome-devtools-mcp@latest` (3.0.0) is broken: its
> `package.json` declares `files: ["build/src"]` but the tarball ships 3 files and no
> `build/`, so `npx` fails with `chrome-devtools-mcp: not found`. Use `2.3.2`.

---

## 2. What is built and verified

Phases 0–4 of `autorag-build-plan.md` are complete.

| Area | State |
|---|---|
| RAG core (`src/rag/`) | embed · chunk · store · search · lexical · screen · ingest |
| Tool surface (`src/webmcp/`) | 14 imperative tools + 1 declarative form-derived |
| Curation | review queue, conflict badges, agent adjudication, activity log |
| Retrieval | hybrid dense+BM25, typo tolerance, calibrated confidence |
| UI | ingest, review, search, corpus management, activity, declarative form |
| Docs | README, MANUAL, TOOL-CONTRACT, API-DELTA, DEMO-SCRIPT, SUBMISSION, HUMAN-TASKS |
| Build | `pnpm build` static export clean; full loop verified on the export |

**Measured, not asserted:**

```
pnpm bench    top-1 21/21    no overclaim 3/3    no withhold 25/25
```

Also verified by running: cross-session persistence across a full browser restart,
stale demotion at exactly 0.60, structured errors on every failure path, dynamic tool
registration through the MCP bridge, and the declarative `<form>` tool appearing in
`getTools()` on native Chrome.

---

## 3. The findings that shaped the design

All in `lib/webmcp/API-DELTA.md` with reproductions. The ones that matter most:

**D12 — MCP bridges forward only an MCP `CallToolResult` envelope.** The big one.
`executeTool()` from page script serializes anything, so bare objects tested fine. But
agents connect through an MCP bridge, and it silently drops any other shape. For most
of the build **all 15 tools returned empty to every agent** while every test passed.
Fixed centrally in `toCallToolResult()` in `src/webmcp/registry.ts`. *Lesson: test
through the path the consumer actually uses.*

**D11 — aborting a tool group destroys that group's own in-flight call.** Chrome 151
rejects the pending `executeTool` with `UnknownError`. `autorag_approve_pending` empties
the queue and so retracts its own group: the approval committed, then the agent got an
opaque exception, and a retry returned `NOT_FOUND`. Hence `src/webmcp/lifecycle.ts`
splits directions — `syncToolGroups()` only adds (synchronously, so an agent told to
poll a tool finds it), `sweepRetired()` only removes (from a React effect, after the
call returns).

**D3/D4 — `execute` takes one argument; `requestUserInteraction` does not exist.**
Chrome's docs show `(params, {signal})`. The runtime disagrees, on native and polyfill.
There is no second argument, so nothing can carry `requestUserInteraction`. The human
gate is therefore in-page, which is the better design anyway.

**D5 — `inputSchema` differs by Chrome version.** Native 149–153 returns a serialized
string; 154+ and the polyfill return an object. Always use `normalizeInputSchema()`.

**D13 — `registerTool` rejects with `AbortError` if its signal fires mid-call.** Benign,
but it left an uncaught rejection in the console on every dev load, because
`registerGroup` aborts the previous controller and StrictMode double-invokes the effect.
`registerGroup` now absorbs an abort of its own controller and returns `false`, and
`addMissing` takes its group flags from that return value instead of setting them
optimistically. Same primitive as D11, opposite direction: an aborted *execution* is
unrecoverable, an aborted *registration* is fine.

**Bugs in our own code, all caught only by measuring:**

- *Contradiction detection was inverted.* Contradictory passages are textually
  near-identical ("Max, 92%" vs "Netflix, 79%" scores 0.93), so the near-duplicate
  check swallowed every contradiction. The differing-figures test must run first.
- *Screening ignored pending material.* Agents harvest in bursts before anything is
  approved, so a four-source batch containing a flat contradiction produced **zero**
  flags. Now all three statuses are screened.
- *Five defects in the tool contract*, found by actually running `evals/` through the
  bridge. Written up in `evals/RESULTS.md`; the pattern is in §4 rule 5.

---

## 4. Architecture rules — do not regress these

Both were violated once and fixed. They are the same lesson twice: **every layer does
only what it is actually capable of.**

1. **Screening nominates; it never rules.** Embedding distance can establish two
   passages are about the same subject, never that they disagree. `screen.ts`
   shortlists → `autorag_adjudicate_conflict` lets the agent rule → the human decides.

2. **Retrieval reports; it never instructs.** Autorag has no LLM and cannot see the
   caller's conversation, so it must not decide a question is unanswerable.
   `coverage_note` once emitted *"say so rather than inferring an answer"* — a retriever
   overruling an LLM on information it does not have. A follow-up like "how long is it"
   scores 0.10 yet the passage contains the runtime, and only the agent knows what "it"
   means. Now it returns passages **always**, plus `match_signals`, and the agent judges.

3. **Never say "train."** Nothing is trained. Say ingest, index, memory, corpus.

4. **The review queue is steering, not security.** Do not pitch it as a defence against
   anything (`amendments.md` A1, A4).

5. **A description describes what the runtime does, not what you wish it did.** Three of
   the five eval defects were the same shape: `forget_source` promised a dry run and
   returned an error; `get_stats` claimed to summarize the memory while omitting the
   field an agent needed; a conflict flag said figures "differ" when all it had computed
   was a set difference. Agents believe descriptions. When you change a payload, reread
   the sentence that promises it.

---

## 5. What is NOT verified — the honest gap

**Narrowed on 2026-09-01, not closed.**

The eleven questions in `evals/autorag_eval.xml` have now been run end to end through
the MCP bridge and score 11/11 — see `evals/RESULTS.md`, which also lists the five
defects the run found. Every tool in the surface has been called through the path an
agent actually connects over, including the rejection-memory round trip.

What that does **not** establish is the one claim `amendments.md` A5.2 says the
submission is won on:

> An agent, seeing only the tool descriptions, picks the right tool with the right
> arguments.

The caller in that run had the repo in context. So the eval proves the arguments are
guessable from the schemas and the results answer the questions — but not the *choice*
of tool, which is the failure mode that overlapping descriptions cause. Nothing here can
prove that except an agent that has never seen this code.

**To close it:**

1. Point an agent with none of this context at `http://localhost:3111` and ask only:
   *"Figure out what this page does and save something useful to it."* Watch which tool
   it reaches for first and whether it invents arguments.
2. Give it the eleven questions and diff against the answer key.
3. Any wrong tool choice is a **description bug**, not an agent bug. Fix the wording —
   that is what happened to all five defects in `RESULTS.md`.

---

## 6. What is left

**Blocked on the user** (see `HUMAN-TASKS.md`):

- [ ] Push the repo. `gh` is authed as `dogeyboy1932`. The command is
      `gh repo create autorag --public --source=. --remote=origin --push`.
      Claude is blocked from running this by the permission classifier — publishing is
      the user's call. Must be **public** for the MIT licence to show in GitHub's About
      panel, which the submission requires.
- [ ] Deploy (Vercel account exists; static export also works on Netlify).
- [ ] Record the video — script ready in `lib/demo/DEMO-SCRIPT.md`.
- [ ] Submit on Devpost (already registered). Draft in `SUBMISSION.md`, all four
      required questions answered.

**Deferred by decision, do not "fix":**

- ChatGPT's in-app browser is **out of scope**. Docs say Chrome 151 is the tested
  surface and other hosts are untested. Do not add claims about untested hosts.
- Token benchmark (`webmcp-devtools-takeaways.md` §3) cut for functionality. ~1h to
  reinstate; needs an `ANTHROPIC_API_KEY`, which nothing else in the project does.
- React Flow corpus graph — build last or not at all.
- `find_gaps` / `get_frontier` — stay out unless there is real computation behind them.

---

## 7. Decisions already made — don't relitigate

| Decision | Why |
|---|---|
| Corpus is **movies & streaming** | Availability rots and aggregators disagree, so curation has real material. Real sources with a synthetic fallback for recording. |
| Human gate is **in-page** | `requestUserInteraction` does not exist (D4). |
| Conflicts: **heuristic nominates, agent adjudicates** | Neither can do the other's job. |
| **No secrets.** `.env.local.example` is entirely commented out | Needing no API key *is* the architectural claim. |
| Deploy target **Vercel**, static export | Keeps Netlify available. |
| MCP-B extension is **dev-loop only** | The submission must not require a judge to install anything. |

---

## 8. Gotchas that look like bugs

| Symptom | Reality |
|---|---|
| Only 4–5 tools listed at first | Correct. Approval tools appear when something is staged; retrieval tools when something is approved. |
| `call_webmcp_tool` returns "no output" | **A real bug.** Result shape is wrong — see D12. |
| A one-word search scores 0.2 and is right | Normal. Short queries always score low; trust `confidence`, not the number. |
| `how long is it` reports low confidence | Correct. The score measures wording overlap; the passage still contains the answer and the note says so. The agent decides. |
| First page load takes ~60s | 25MB model download, cached afterwards. |
| Backend reports `wasm` not `webgpu` | Fine. Headless Chrome has no GPU adapter. |
| Header badge says 15 tools, `alwaysTools` etc. sum to 14 | Correct. The badge reads `getTools()`, so it counts the form-derived tool the browser adds without going through `registerGroup`. |
| Screening flags a pair over years like 2024/1965 | Expected. The check is a set difference over numbers, and the flag now says exactly that. Adjudication is where meaning enters. |

Changing `next.config.mjs` needs the dev server restarted; `devIndicators: false` was
added there so the floating chip stays out of the video, and it will not take effect
until you restart `pnpm dev`.

---

## 9. Repo map

```
MANUAL.md          ← plain-language guide + test plan. Start here.
HANDOFF.md         ← this file
HUMAN-TASKS.md     ← what only the user can do
SUBMISSION.md      ← Devpost draft, four required questions answered
README.md          ← technical README for judges
lib/webmcp/API-DELTA.md        ← 13 verified findings. Highest-value doc.
lib/tool-design/TOOL-CONTRACT.md  ← all 15 tool schemas
lib/demo/DEMO-SCRIPT.md        ← shot-by-shot video script
lib/rag/chunking-notes.md      ← chunk sizes, normalization, backend choice
bench/             ← retrieval benchmark (pnpm bench)
evals/             ← 11 QA pairs + seed corpus + RESULTS.md (run, but not blind)
probes/            ← standalone pages used to establish API-DELTA facts
src/rag/           ← embed · chunk · store · search · lexical · screen · ingest · bus
src/webmcp/        ← registry · lifecycle · errors · tools/
components/        ← ReviewQueue (the star of the video), CorpusView, ActivityLog, …
```

---

## 10. If you change one thing, re-run these

```bash
pnpm typecheck
pnpm build
pnpm bench                    # 21/21, 3/3, 25/25
```

And then, because `pnpm bench` cannot catch a D12-class failure, call one tool through
the **MCP bridge** and confirm real JSON comes back:

> Using chrome-devtools, call `autorag_get_stats` on http://localhost:3111.

"Completed with no output" means results are not reaching agents.
