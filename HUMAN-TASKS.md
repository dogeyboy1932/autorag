# From here to demo-ready

Everything is built. Nothing below is construction — it is you getting hands on the
thing, in order, so that by the time you point a camera at it there are no surprises.

Budget **about 45 minutes** for steps 1–5. Do them in order the first time.

- Deeper reference on any of this: **`MANUAL.md`**
- Shot-by-shot for the recording: **`lib/demo/DEMO-SCRIPT.md`**
- Picking the code back up: **`HANDOFF.md`**

---

## Where it actually stands

| | |
|---|---|
| Phases 0–4 of the build plan | Complete, gates re-run and passing |
| Retrieval benchmark | 21/21 top-1, 3/3 no-overclaim, 25/25 no-withhold |
| Cross-browser conformance | 15/15 on Brave (Chromium 152), re-verified on Chrome 151 |
| Verified findings about the browser | 15, all by running them — `lib/webmcp/API-DELTA.md` |
| Repo | 10 commits, **nothing pushed** |

One thing has never been tested, and it is the thing the submission is judged on. That
is **step 5**. Do not skip it.

---

## Step 1 — Get it running (5 min)

**Terminal:**

```bash
pnpm install
pnpm dev            # http://localhost:3111
```

**Then launch Brave with the agent feature on.** Your everyday Brave window will show
the page fine but agents will not see any tools:

```bash
brave --enable-features=WebMCP http://localhost:3111
```

> **Quit Brave completely first.** If any Brave window is already open, this command
> just opens a tab in the running process and **your flag is silently ignored** — you
> get a page with no tool surface and no error explaining why. Fully quit, then run it.
> (Snap install: the binary is `/snap/bin/brave`.)

Chrome works identically with `google-chrome --enable-features=WebMCP`. Ignore
`chrome://flags/#enable-webmcp-testing` — the flag exists, the command-line switch does
not work.

**First load takes about a minute** while a 25MB embedding model downloads. Cached
after that.

### Reading the top bar

| Badge | Meaning |
|---|---|
| 🟢 `15 tools on document.modelContext` | Working. Agents can see the tools. |
| 🟢 `model ready · webgpu` | Ready. (`wasm` instead of `webgpu` is fine, just slower.) |
| 🟠 `downloading embedding model · 40%` | Wait. One time only. |
| 🔴 `no WebMCP surface` | The flag did not take — see the warning above. |

**Fewer than 15 tools is not a bug.** The surface grows with the memory: 5 when empty,
9 once something is staged, 15 once something is approved. An agent is never offered a
search tool for an empty memory.

### One Brave-specific thing

The only request this app ever makes to the outside world is the one-time model
download from `huggingface.co`. **Brave Shields can block it.** If the badge sits at 0%
forever, drop Shields for `localhost` and reload. After it caches once you can put
Shields straight back up — the app makes zero external requests from then on, which
you can confirm in the Network tab.

---

## Step 2 — Prove it works without touching anything (3 min)

Two automated suites. Run both before trusting anything by eye.

```bash
pnpm bench     # retrieval quality — expect 21/21, 3/3, 25/25
pnpm loop      # the whole product through WebMCP — expect 15/15
```

`pnpm loop` is the important one. It launches a **throwaway** Brave profile (your real
profile is never touched), and drives the entire product through
`document.modelContext.executeTool` — the path an agent uses, never the UI. Ingest,
conflict flagging, agent adjudication, rejection, approval, retrieval with provenance,
rejection replay, the declarative form, structured errors. It exits non-zero if
anything fails.

Point it anywhere:

```bash
pnpm loop --executable /usr/bin/google-chrome
pnpm loop --url https://your-deploy.example      # after you deploy
```

**Run it on both browsers.** That is not belt-and-braces: one bug in this project was
green on Chrome 151 and red on Brave (API-DELTA D15). Two engines caught something one
engine could not.

---

## Step 3 — Drive it by hand (10 min)

Now use it as a person. Full detail in `MANUAL.md` §4; the short version:

1. **Save something.** Paste a few paragraphs into **Ingest a passage** with a URL and
   title → *Stage for review*. A card appears in the Review queue.
2. **Approve and search.** Click *Approve*, then search for a word from the passage.
   It comes back with its source and date.
3. **Close the tab and reopen it.** Everything is still there. This is the entire point
   of the product — memory that outlives the session.
4. **Feed it a contradiction.** Ingest a near-copy of your first passage with one number
   changed and a different URL. The card gets an orange **conflicting figures** badge.
5. **Reject it with a reason.** Then ingest the exact same text again — it comes back
   flagged, quoting *your own words* about why you turned it down.

If those five work, the app works.

---

## Step 4 — Drive it with an agent (15 min)

Steps 1–3 used buttons. **The product is an agent using the tools** — that is what you
are actually demonstrating.

```bash
claude mcp list      # should list chrome-devtools and webmcp-docs
```

If those are missing from your session, restart Claude Code. MCP servers load at
session start, so one added mid-session stays invisible until you restart. That cost
this project a day once.

Then, dev server running, ask your agent in order:

| # | Ask | What proves it worked |
|---|---|---|
| 1 | *"Using chrome-devtools, call `autorag_get_stats` on http://localhost:3111 and show me exactly what came back."* | Real JSON — `chunk_count`, `model_ready: true` |
| 2 | *"Read the Wikipedia page for Dune: Part Two and save what matters to Autorag."* | Review queue fills; **Agent activity** panel scrolls live |
| 3 | *"What's in the review queue, and does anything conflict?"* | Names the passages and the conflicts |
| 4 | *(approve some in the UI)* → *"Now, where can I stream Dune: Part Two?"* | Answers **and cites the source URL and ingest date** |
| 5 | *"Delete the Wikipedia source."* | **Refuses** without `confirm: true` and suggests marking it stale instead |

**Test 1 is the canary and test 5 is the interesting one.** A good tool surface does not
just work — it stops an agent doing something destructive by accident and tells it what
to do instead.

### The three failure signatures

If a tool call misbehaves, the shape of the failure tells you which bug it is:

| What you see | What it means |
|---|---|
| *"Completed with no output"* | Results are not reaching agents. API-DELTA D12. |
| The call hangs until a 120s timeout | Nothing is submitting. D14, the declarative form. |
| Returns fine but the counts did not move | It answered without doing the work. |

All three have happened here. That last row is why any check should confirm the
**state** changed, not just that a result came back.

---

## Step 5 — The test nobody has run

Everything so far is driven either by a script naming tools directly, or by someone who
already knows what the tools mean. So this claim is still untested:

> An agent, seeing only the tool descriptions, picks the right tool with the right
> arguments.

MCP exists precisely so a model can choose the appropriate tool. That makes this the
claim the whole submission rests on, and it is the one gap left.

**How to run it.** Open a **completely fresh** agent session — no context about this
project, no repo access — and say only:

> There's a page at localhost:3111. Figure out what it does and save something useful
> to it.

Watch two things: **which tool it reaches for first**, and **whether it invents
arguments**.

Then hand it the eleven questions in `evals/autorag_eval.xml` and compare against the
answers in that file.

**How to read the result.** A wrong tool choice is a **description bug, not an agent
bug.** If it picks `autorag_search` when it wanted `autorag_check_coverage`, those two
descriptions overlap and one needs sharpening. That is a five-minute fix in
`src/webmcp/tools/`, and it is the highest-value edit left in the project.

For context: the eleven questions have been run end-to-end through the MCP bridge and
score 11/11 (`evals/RESULTS.md`) — but by a caller who knew the repo. That run proves
the arguments are guessable and the results answer the questions. It cannot prove the
*choice*.

---

## Step 6 — Pre-flight before you record

- [ ] `pnpm bench` → 21/21, 3/3, 25/25
- [ ] `pnpm loop` → 15/15
- [ ] **Restart `pnpm dev`** if you have not since the last config change — the
      floating Next.js dev chip is switched off in `next.config.mjs`, but only a
      restart applies it, and it sits on top of the page for the whole take
- [ ] Brave fully quit, then relaunched with `--enable-features=WebMCP`
- [ ] Badge green: **model ready** (do not record a progress bar)
- [ ] Badge green: **N tools on document.modelContext**
- [ ] Memory **empty** — the arc is wrong → right, so it has to start from nothing
- [ ] `evals/seed-corpus.json` open in a second tab as a fallback if a live page has
      changed under you
- [ ] Shields down for `localhost`, or the model already cached

---

## Known rough edges — expected, not broken

Say these out loud if they come up rather than hoping nobody notices.

| | |
|---|---|
| **Screening misses some real conflicts.** | It caught one of two disagreements in a test source. The missed pair scored 0.659 cosine against a same-subject threshold of 0.72, so it was never nominated. By design screening only nominates; the agent and you still rule. Lowering the threshold in `src/rag/screen.ts` would catch it at an unmeasured precision cost. |
| **Conflicts list years among the numbers.** | It over-flags on purpose. The flag says the two passages carry numbers the other does not — it does not claim they disagree. |
| **A one-word search scores 0.2 and is still right.** | Short queries always score low. Trust the **confidence** label, not the raw number. |
| **"how long is it" reports low confidence.** | Correct behaviour. The score measures wording overlap; the passage still holds the answer and the note says so. Only the agent knows what "it" refers to, so the agent decides. |
| **First load takes ~60 seconds.** | The model download. Once only. |

---

## Still genuinely blocked on you

Only two, and neither is demo-blocking:

- **Push the repo.** `gh` is authed as `dogeyboy1932`. Must be **public** for the MIT
  licence to show in GitHub's About panel.
  ```bash
  gh repo create autorag --public --source=. --remote=origin --push
  ```
- **Deploy.** Vercel account exists; it is a static export so Netlify works too. Login
  is interactive — in Claude Code type `!vercel login` to run it in-session. Then point
  the suite at it: `pnpm loop --url https://your-deploy.example`.

Video and Devpost are yours; the script is in `lib/demo/DEMO-SCRIPT.md` and the draft
text with all four required questions answered is in `SUBMISSION.md`.

---

## If something is genuinely wrong

| Symptom | Fix |
|---|---|
| 🔴 `no WebMCP surface` | A Brave window was already open when you passed the flag. Quit completely and relaunch. |
| Badge stuck orange at 0% | Brave Shields, or no route to `huggingface.co`. Needs one-time access. |
| Agent cannot see the tools | Wrong browser window, or the tab is closed. **The tab must stay open** — the tools live on the page. |
| Everything vanished | Private window, cleared site data, or a different browser profile. Storage is per-profile. |
| A tool call returns `UnknownError` | Should be fixed (D11, D15). If it recurs, that is a real regression — say so, do not work around it. |

Anything not covered here: `MANUAL.md` §7 and §8 go deeper.
