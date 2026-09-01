# Autorag — the manual

Plain language. No jargon without explaining it first. If you read only one section,
read **"Test it in 10 minutes."**

---

## 1. What this thing is

Autorag is a **memory for AI agents that lives in your browser tab.**

The problem it solves: an AI agent forgets everything between conversations. Every time
you come back, it starts from zero. The usual workaround is to paste your documents in
again, which is tedious and has three specific problems — it doesn't stick around, you
can't tell where any fact came from, and nobody ever checked whether the material was
any good.

Autorag fixes all three:

1. **It sticks around.** Close the tab, restart your computer, come back next week —
   it's all still there.
2. **It remembers where things came from.** Every answer says which page it came from
   and when it was saved.
3. **You decide what it keeps.** Nothing gets saved without you approving it.

### The one-sentence version

> An agent reads web pages and hands you what it found; you approve or reject each
> piece; what you approve becomes permanent, searchable memory that cites its sources.

### What it is *not*

- **It is not training an AI.** Nothing about any AI model changes. It's a filing
  cabinet, not a school.
- **It is not a chatbot.** Autorag has no AI inside it at all. It hands passages to
  whatever agent is talking to it, and *that* agent writes the answer.
- **It is not a security system.** The approval step is you *steering* what gets
  remembered. It is not protection against anything malicious.

---

## 2. How it works, in five steps

```
   ①  agent reads a web page
        ↓
   ②  agent calls a tool on your Autorag tab: "remember this"
        ↓
   ③  Autorag chops it up, converts it to numbers, checks it against
      what it already knows, and flags anything suspicious
        ↓
   ④  YOU approve or reject it in the Review queue      ← the only manual step
        ↓
   ⑤  approved passages become searchable, forever, with sources attached
```

### The words you'll see on screen

| Word | What it means |
|---|---|
| **Passage** | A block of text saved from a web page. |
| **Chunk** | A passage sliced into a smaller piece. Long pages become several chunks. |
| **Source** | The page a passage came from. Has a title and a URL. |
| **Staged / Pending** | Waiting for you. Not searchable yet. |
| **Approved** | You said yes. Now searchable. |
| **Stale** | Old and probably out of date. Still searchable, but pushed down the results. |
| **Embedding** | The text converted into a list of numbers, so the computer can tell which passages mean similar things. |
| **Tool** | A button an AI agent can press on your page. Autorag offers 15 of them. |
| **WebMCP** | The browser feature that lets a web page offer tools to an AI agent. |

### Why nothing leaves your computer

The text-to-numbers conversion runs *inside your browser tab*. The saved memory sits in
your browser's own storage. There's no server, no account, no API key. The only thing
ever downloaded is the conversion model itself (about 25MB), once, the first time you
open the page.

---

## 3. Getting it running

You need **Google Chrome version 149 or newer**. Check yours at `chrome://version`.

**Terminal 1 — start the app:**
```bash
pnpm install
pnpm dev
```
It'll say `http://localhost:3111`.

**Open Chrome with the agent feature switched on.** This matters — a normal Chrome
window will show the page but agents won't see the tools:
```bash
google-chrome --enable-features=WebMCP http://localhost:3111
```

> **Careful:** there's a setting at `chrome://flags/#enable-webmcp-testing` that *looks*
> like the right one. Turning it on works. But the command-line version
> `--enable-webmcp-testing` does **not** work. Use `--enable-features=WebMCP`.

**First load takes a minute.** Top-right shows an orange badge counting up while the
25MB model downloads. Wait for it to turn green and say **model ready**. It's cached
after that, so later loads are instant.

### Reading the top bar

| Badge | Meaning |
|---|---|
| 🟢 `15 tools on document.modelContext` | Agents can see your tools. Working. |
| 🔴 `no WebMCP surface` | You forgot `--enable-features=WebMCP`, or Chrome is too old. |
| 🟢 `model ready · wasm` | Ready to go. (`wasm` or `webgpu` — both fine, webgpu is faster.) |
| 🟠 `downloading embedding model · 40%` | Still loading. Wait. |

---

## 4. Test it in 10 minutes

No agent needed. Do this first — it proves the whole thing works.

### Test 1 — Save something (2 min)

1. In **Ingest a passage**, fill in:
   - Source URL: `https://en.wikipedia.org/wiki/Dune:_Part_Two`
   - Title: `Dune: Part Two - Wikipedia`
   - Passage: paste a few paragraphs from that page
2. Click **Stage for review**.

✅ **Pass:** it says "Staged N chunks for review" and a card appears in **Review queue**.
❌ **Fail:** nothing happens → check the model badge is green.

### Test 2 — Approve, then search (2 min)

1. Click **Approve** on the card.
2. In **Search the memory**, type `runtime` and hit Enter.

✅ **Pass:** your passage comes back, with the source title, a score, and the date.
❌ **Fail:** "No approved chunks matched" → you didn't approve it in step 1.

### Test 3 — It survives being closed (1 min)

1. Close the browser tab completely. Reopen `localhost:3111`.

✅ **Pass:** the counts at the top still show your passage. **This is the whole point of
the product** — memory that outlives the session.
❌ **Fail:** counts are zero → you're in Incognito, or site data was cleared.

### Test 4 — It catches a bad source (3 min)

1. Ingest a second passage that **contradicts** the first. Easiest way: copy your first
   passage, change a number in it (a score, a year, a runtime), and give it a different
   URL and title.
2. Look at the new card in the Review queue.

✅ **Pass:** an orange **conflicting figures** badge, showing which numbers disagree.
❌ **Fail:** no badge → the two passages are too different. Keep the wording nearly
identical and change only a number.

### Test 5 — It remembers being told no (2 min)

1. Click **Reject** on that card. Type a reason: `Numbers don't match the official page.`
2. Ingest the *exact same text* again.

✅ **Pass:** flagged immediately, quoting **your own rejection reason back to you**.
❌ **Fail:** no flag → the text wasn't identical enough.

**If all five pass, the app works.**

---

## 5. Testing it with an actual AI agent

The tests above use the buttons. The real product is an agent using the tools.

**Setup.** Two MCP servers are already configured in this project:

```bash
claude mcp list          # should show chrome-devtools and webmcp-docs
```

Then, with the dev server running, ask your coding agent:

> Using the chrome-devtools MCP server, open http://localhost:3111 and list the WebMCP
> tools that page offers.

You should get about 4 tools starting with `autorag_`. (Only 4 at first — more appear as
the memory fills. That's deliberate, see §7.)

### The five agent tests

| # | Ask the agent | What proves it worked |
|---|---|---|
| 1 | "Call `autorag_get_stats` and show me the raw result." | JSON with `chunk_count`, `model_ready: true` |
| 2 | "Read the Wikipedia page for Dune: Part Two and save the important parts to Autorag." | Review queue fills; **Agent activity** panel scrolls |
| 3 | "What's in the review queue, and does anything conflict?" | Lists passages and names the conflicts |
| 4 | *(you approve some in the UI)* "Now, where can I stream Dune: Part Two?" | Answers **and cites the source URL and date** |
| 5 | "Delete the Wikipedia source." | Refuses without `confirm: true`, suggests marking stale instead |

**Test 5 is the interesting one.** A good tool surface doesn't just work — it stops an
agent doing something destructive by accident, and tells it what to do instead.

### Testing through the real MCP path (do this one)

There are **two different ways** to reach the tools, and they are not equivalent:

| Path | Who uses it | What it proves |
|---|---|---|
| `document.modelContext.executeTool()` from page script | test scripts | the tool logic works |
| An MCP bridge (`call_webmcp_tool`) | **every actual agent** | the tool works *for an agent* |

For most of this build only the first was tested, and every test passed — while all 15
tools returned **empty responses** to any agent connecting over MCP. The bridge forwards
only a specific result shape and silently drops anything else. See
`lib/webmcp/API-DELTA.md` D12.

So test the second path:

> Using the chrome-devtools MCP server, call `autorag_get_stats` on http://localhost:3111
> and show me exactly what came back.

✅ **Pass:** a JSON object with `chunk_count`, `model_ready`, and so on.
❌ **Fail:** *"completed with no output"* → results are not reaching agents. This is the
failure mode to watch for after any change to how tools return values.

### The hardest test: does an agent understand the tools cold?

Open a **fresh** agent session with no context and ask something vague:

> There's a page at localhost:3111. Figure out what it does and save something useful
> to it.

✅ **Pass:** it works out the ingest-then-review flow from the tool descriptions alone.
❌ **Fail:** it calls the wrong tool, or invents arguments → **that's a documentation
bug, not an agent bug.** The description needs to be clearer.

**This test has never been run.** Everything verified so far either drives the tools by
name from a script, or is driven by someone who wrote the descriptions and therefore
already knows what they mean. Nobody has handed the tools to an agent that has never
seen this project. Until that happens, treat "the tool descriptions are good" as an
untested claim — and it is the specific claim this project is judged on.

The same applies to `evals/autorag_eval.xml`. Its expected answers are now *measured*
rather than guessed, which is an improvement, but the questions have never been given to
an agent. It is a correct answer key for an exam nobody has sat.

---

## 6. Testing with all kinds of data

The goal is that it handles whatever gets thrown at it. Here's how to check.

### Messy input

Paste raw HTML with cookie banners, navigation and `<script>` tags into the ingest box.

✅ **Pass:** the stored passage shows clean prose. Menus, "Accept all cookies", copyright
lines and script contents are gone; tables survive as `Max · Streaming`.

### Query shapes

Search these against a corpus that can answer them:

| Type | Example | Should |
|---|---|---|
| One word | `netflix` | Find the streaming source |
| Bare number | `166` | Find the passage containing it |
| Odd token | `PG-13` | Find the ratings source |
| Typo | `villenueve` | Still find Villeneuve |
| Casual | `is dune on netflix` | Work fine |
| Full question | `Where can I stream it?` | Work fine |
| **Nonsense** | `how do I bake sourdough` | Say **not covered** — this matters as much as the rest |

Run all of these automatically:

```bash
pnpm dev          # terminal 1
pnpm bench        # terminal 2
```

Currently: **top-1 100%, usable verdict 100%.** Exits non-zero if anything regresses, so
you can run it after any change.

### Why low confidence does not mean "no answer"

Type `how long is it` into search. It finds the right passage, but the confidence says
**low**. That looks broken. It isn't — and the reason explains the whole design.

Autorag has no AI in it. It cannot know that "it" means the film you were just
discussing, because it cannot see your conversation. The agent can. So Autorag's job is
to hand over the passages and say honestly what it does and doesn't know, and the
**agent** decides whether that's an answer.

The score is only measuring *how much your wording overlaps the stored text*. For a
follow-up question that overlap is near zero even when the answer is sitting right
there. So the tool says so in as many words:

> "This query refers to something it does not name, which only you can resolve — so the
> score reflects wording, not whether the answer is here. Judge these passages on their
> content."

Compare a genuinely unanswerable question, `how do I bake sourdough`, which scores the
same but gets a different message:

> "No passage contains 'bake', 'sourdough' — the match rests on meaning rather than
> wording."

Same number, two different situations, and the agent is told which is which.

**Passages are returned either way.** Autorag never withholds them and never tells the
agent to give up — that would be a retrieval tool overruling the thing that actually has
the context.

---

## 7. Things that look broken but aren't

| What you see | Why |
|---|---|
| Only 4 tools at first, more later | Deliberate. Approval tools appear when something's waiting; search tools appear once something's approved. An agent is never offered a search tool for an empty memory. |
| First load takes ~60 seconds | The 25MB model. Once only — later loads are instant. |
| Searching returns nothing after marking something stale | Stale sources are hidden by default. The result tells the agent to retry with `include_stale`. |
| A one-word search scores 0.2 and still finds the right thing | Normal. Short queries always score low. Trust the **confidence** label, not the number. |
| Backend says `wasm` not `webgpu` | Fine. WASM is the fallback and is a bit slower. Headless Chrome always uses it. |
| Conflict lists years among the numbers | It over-flags on purpose. Better to surface too much for you to dismiss than to miss a real contradiction — which is why the flag says the two passages carry numbers the other does not, rather than claiming they disagree. |

---

## 8. When something is genuinely wrong

| Symptom | Fix |
|---|---|
| 🔴 `no WebMCP surface` | Relaunch with `--enable-features=WebMCP`. Chrome must be 149+. |
| Badge stuck orange | No internet, or the model CDN is blocked. Needs one-time access to huggingface.co. |
| `embeddings unavailable` | Neither WebGPU nor WASM started. Check the browser console. |
| Agent can't see tools | Wrong Chrome window, or the tab is closed. The tab must be open — tools live on the page. |
| Everything vanished | Incognito, cleared site data, or a different Chrome profile. Storage is per-profile. |
| Agent gets `UnknownError` | Should be fixed — see `lib/webmcp/API-DELTA.md` D11. If it recurs, that's a real regression. |

---

## 9. Where things live

| I want to… | Look at |
|---|---|
| Pick up where the last session left off | `HANDOFF.md` |
| Understand the tools | `lib/tool-design/TOOL-CONTRACT.md` |
| Know what the browser actually does | `lib/webmcp/API-DELTA.md` — verified by running it, not by reading docs |
| Record the demo video | `lib/demo/DEMO-SCRIPT.md` |
| Know what only I can do | `HUMAN-TASKS.md` |
| Submit to Devpost | `SUBMISSION.md` |
| Change how text is split | `src/rag/chunk.ts`, notes in `lib/rag/chunking-notes.md` |
| Change conflict sensitivity | `src/rag/screen.ts` — the thresholds at the top |
| Change search behaviour | `src/rag/search.ts` and `src/rag/lexical.ts` |

---

## 10. The 60-second pre-recording checklist

Before pointing a camera at it:

- [ ] Chrome launched with `--enable-features=WebMCP`
- [ ] Badge green: **model ready**
- [ ] Badge green: **N tools on document.modelContext**
- [ ] `pnpm bench` passes
- [ ] Memory is **empty** (the demo starts from nothing — wrong answer first, right
      answer after)
- [ ] Fallback passages ready in a second tab in case a live page has changed
