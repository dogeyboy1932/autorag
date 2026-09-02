# Testing Autorag

Everything Autorag is meant to do, and how you check each one yourself.

Autorag is a curated memory that lives in your browser. You keep things while you read; you
decide what stays; any agent that speaks WebMCP can search what survived. No server, no
account, no API key, and nothing leaves your machine except a one-time model download.

I can prove most of this by running it — see [What I can prove without you](#what-i-can-prove-without-you)
at the bottom. **What I cannot do is use it.** The tests below are the ones that need a
person: they are about whether it feels right, not whether it returns the right JSON.

---

## Set up (2 minutes, once)

```bash
pnpm install
pnpm ext
```

Then in Brave or Chrome: `brave://extensions` → **Developer mode** (top right) →
**Load unpacked** → select `extension/dist`.

That is the whole install. It now runs on every tab; nothing to start, no server.

**The first capture takes about a minute** while a 25MB embedding model downloads, once.
The side-panel header tracks it: `downloading model 40%` → `model ready · wasm`. Cached
after that.

> **If it never becomes ready:** Brave Shields is blocking the one-time download from
> `huggingface.co`. Drop Shields for that request once, reload, then put them back up.
> Nothing else in the extension touches the network — worth confirming in the Network tab
> while you are there.

Open the side panel with the toolbar icon. Five sections: **Reading now**, **To review**,
**Recall**, **Manage corpus**, **Activity**.

---

## The features, and how to test each

Work down the list. Each one says what it is meant to do, what you do, and what "working"
looks like — so a failure is something you can name rather than a vague sense that it was
awkward.

### 1. Capture costs one gesture

*Meant to:* let you keep something from wherever you already are, without opening an app,
copying, or pasting a URL anywhere.

Four ways in. Try all four on real pages you were reading anyway:

| Do this | Expect |
|---|---|
| Highlight text | A **Keep** button appears next to the selection; clicking it turns to "Kept" |
| Highlight, then `Ctrl+Shift+K` | Same, without touching the mouse |
| `Ctrl+Shift+E` with nothing selected | Keeps the whole article you are reading |
| Right-click a selection → **Keep this in Autorag** | Same as the button |

Shortcuts clash; rebind at `brave://extensions/shortcuts`. **The panel shows the binding
you actually have** rather than the one the manifest asked for — worth knowing, because
Chromium drops a key it considers taken without saying a word. This bit us: `Ctrl+Shift+S`
was the original default and Brave's own screenshot tool owns it, so that shortcut never
existed while three documents told people to press it. `pnpm ext:check` now fails if any
declared shortcut comes back unassigned.

**Passes if:** each of the four stores something, and you never had to leave the page.
**Tell me if:** any of them costs a second gesture, or gives you no sign it worked.

### 2. Whole-page capture shows you what it got, first

*Meant to:* let you keep a long article without selecting 2,000 words, while never storing
something you have not seen.

Open the panel on an article and press **Preview this page** under *Reading now*. Then try
**Preview selection**.

**Passes if:** you get the article's text in an editable box, roughly the body without
navigation and cookie banners, and **nothing is stored** until you accept it. Trim it in
the box and confirm the trimmed version is what lands in the queue.
**Tell me if:** the extraction grabs menus and footers, or misses the article on a site you
care about. It uses `<article>`, else `<main>`, else body-minus-chrome — deliberately crude,
and I want to know which real pages defeat it.

### 3. Nothing is searchable until you approve it

*Meant to:* keep the memory something you curated, not something that accumulated.

Keep three or four things, then open **To review**. Approve some, discard others.

**Passes if:** approved passages become findable in **Recall** and discarded ones never do.
Check the counts in the header move the way you expect.
**Tell me if:** anything shows up in Recall that you did not approve. That is the one
invariant the whole design rests on.

### 4. A discard is remembered, with your reason

*Meant to:* stop the same rejected material coming back at you silently.

Discard something and type a real reason ("marketing copy, not a fact"). Then keep the same
passage again from the same or a similar page.

**Passes if:** it comes back into the queue **flagged**, quoting your own sentence back at
you.
**Tell me if:** it returns unflagged — that means screening did not connect the two.

### 5. Screening flags related material — and deliberately over-flags

*Meant to:* nominate pairs worth a second look. It flags three kinds: `duplicate`,
`near_duplicate`, and `contradiction`.

The one worth testing on purpose: read two sources on the same subject that carry different
figures — a spec page and a review with different numbers, two articles with different
dates. Keep a passage from each.

**Passes if:** the second one lands in **To review** with a `contradiction` badge naming
the specific figures that differ.
**Expected, not broken:** it flags things that are not real conflicts. It cannot read; it
sees "same subject, different numbers" and hands it to you. It also misses some real ones —
a measured miss scored 0.659 against a 0.72 same-subject threshold. **It nominates, you rule.**

### 6. An agent triages the flags before they reach you

*Meant to:* make the over-flagging affordable. An agent reads both passages and leaves you a
sentence, so you decide from a reading rather than by comparing two passages yourself.

This is the newest piece. Test it with any agent that can drive your browser over WebMCP —
Claude Code with chrome-devtools-mcp, or your desktop MCP client through the bridge in §11.
With something flagged in the queue, ask it:

> Check my Autorag review queue for flagged passages and rule on any conflicts you find.

**Passes if:** the flagged card in **To review** grows a blue block underneath —
`agent: not actually a conflict` or `agent: the new one supersedes the old` — with the
agent's reasoning and the line *"Advisory. You still decide."*
**And crucially:** the agent must **not** be able to approve or discard. Ask it to approve
something and it should tell you it cannot. If an agent ever approves anything, that is a
bug, not a feature.
**Tell me if:** the reasoning is vague or cites similarity scores instead of the actual
claims — that is a wording bug in the tool description and I fix it in
`extension/src/content/webmcp.ts`.

### 7. Recall returns passages and sources, never an answer

*Meant to:* report what you kept, with provenance, and let you (or your agent) judge.
There is no LLM anywhere in Autorag.

Search **Recall** for something you kept a while ago. Try a single word, a full question,
and a typo.

**Passes if:** you get passages with the URL and date each came from, plus a confidence
label — and it never invents a summary.
**Expected, not broken:** a one-word search scoring 0.2 and being right. Short queries always
score low. Trust the **confidence** label, not the number.
**Tell me if:** something you know is in there does not come back for a reasonable question.
That is the retrieval failure I most want examples of.

### 8. Your memory follows you onto other sites

*Meant to:* be the thing that separates this from a notebook. The memory is not scoped to
the page you kept it from.

Keep something on site A. Go to a completely unrelated site B. Ask an agent driving your
browser what it knows about the topic.

**Passes if:** it recalls the passage from site A while sitting on site B, and cites A.
**Tell me if:** the tools are missing on some site. Some pages have unusual CSP; I want the
list of ones where the surface does not appear.

### 9. Out of date is different from wrong

*Meant to:* let a source stop being authoritative without pretending you never read it.

In **Manage corpus**, pick a source and **Mark out of date**. Search for something it covers.
Then **Forget** a different one.

**Passes if:** the stale source still appears in results but ranks lower and is labelled;
the forgotten one is gone entirely, and forgetting asked you twice.
**Tell me if:** a stale source outranks a fresh one on the same subject.

### 10. It says what it is doing

*Meant to:* stop an empty corpus and a slow model looking identical to a broken extension.

Watch **Activity** during your first capture, and the model badge in the header.

**Passes if:** you can tell, at any moment, whether it is working or idle — chunking,
embedding, screening, downloading, and their outcomes.
**Tell me if:** anything ever happens silently, or a spinner has no explanation next to it.

### 11. Your desktop agent can search what you kept while browsing

*Meant to:* make the memory reachable from the tools you already work in, not only from the
panel.

```bash
pnpm bridge          # serves http://localhost:3210
```

Open `http://localhost:3210` in the browser where the extension is installed and **leave the
tab open**. It should say *7 memory tools exposed to your desktop agent*. Then point any MCP
client at the relay — Claude Desktop, Cursor, anything:

```json
{
  "mcpServers": {
    "webmcp-local-relay": {
      "command": "npx",
      "args": ["-y", "@mcp-b/webmcp-local-relay@latest"]
    }
  }
}
```

Ask it: *"List the connected WebMCP sources, then search my memory for X."*

**Passes if:** it lists your browser as a source, sees the seven `autorag_*` tools, and gets
back real passages with URLs.

**Why the odd extra tab.** Two measured browser limits, both in `lib/webmcp/API-DELTA.md`: a
`ws://127.0.0.1` socket cannot be opened from an `https://` page (D16), and WebMCP refuses to
register tools on a `chrome-extension://` origin (D17). A page served over plain http on
localhost is the only context that is neither. If this should feel less strange later, the
fix is native messaging rather than a loopback socket.

### 12. Nothing leaves your machine

*Meant to:* be true, not just claimed. Embeddings run in your browser; the corpus is in local
storage; there is no backend to send anything to.

Open DevTools → Network on any page, with the panel open, and capture and recall a few things.

**Passes if:** after the one-time `huggingface.co` model download, **no outbound request** is
made by the extension for any capture, search, or agent call.
**Tell me if:** you see one. That would be a serious bug.

---

## The second artifact: the web app

`pnpm dev` → `http://localhost:3111`. Not the product, and you do not need it. It exists
because an agent-browser that cannot run extensions (ChatGPT's in-app browser, for one) can
still visit a URL and find a tool surface there. It carries 15 tools including the ones the
extension deliberately withholds — an agent can approve and reject there, because on that
artifact the agent is the only actor present.

Its corpus is **separate** from the extension's. Different origins, and browser storage does
not cross origins. Accepted, not an oversight.

Test it only if you care about that case: open the page, ask an agent to ingest something,
watch the review queue fill.

---

## What I can prove without you

These run headless against a real browser and either pass or fail. Re-run any of them any
time; if one goes red, that is mine to fix.

```bash
pnpm typecheck && pnpm build && pnpm ext
pnpm ext:check    # the extension end to end, on real third-party pages: 19/19
pnpm ext:relay    # a real desktop MCP client reaching the memory: 6/6

pnpm dev          # these two need the app running, in another terminal
pnpm bench        # retrieval quality: top-1 21/21 · no overclaim 3/3 · no withhold 25/25
pnpm loop         # the web app's 15-tool surface: 15/15
```

`ext:check` covers, among others: a third-party page gains a WebMCP surface it never had;
a highlight-and-click actually stores text; keep → approve → recall returns the passage with
its source; an agent reads the review queue and both sides of a flagged pair; an agent's
ruling lands on the queue where you will read it; the agent **cannot** approve or discard;
and the corpus can be managed.

Worth knowing: a green run on one browser is not proof. One defect (D15) passed on Chrome and
failed on Brave. Both are checked now.

---

## Still unproven — the honest list

1. **Does the corpus survive a full browser restart?** Never explicitly tested: every
   automated run uses a throwaway profile. **You will test this just by using it** — keep
   things today, quit the browser completely, reopen tomorrow, and check they are still in
   **Manage corpus**. Tell me either way.
2. **Does a cold agent pick the right tool from the descriptions alone?** Every test so far
   names the tool directly. The claim MCP exists for — that a model reads a description and
   chooses correctly — is untested. If you point a fresh agent at a page and say only *"save
   something useful here"*, watch which tool it reaches for. A wrong choice is a wording bug,
   and mine to fix.
3. **`page_heading` on every page.** The `@mcp-b/global` polyfill registers a demo tool of
   its own alongside ours. Harmless, not ours, not yet stripped.

---

## Known rough edges — expected, not broken

| | |
|---|---|
| Whole-page extraction is crude | `<article>`, else `<main>`, else body minus nav/header/footer. Beats selecting 2,000 words; not a Readability implementation. |
| Screening misses some real conflicts | It nominates, you rule. One measured miss scored 0.659 against a 0.72 threshold. |
| Screening over-flags | On purpose. An agent triaging first (§6) is what makes that affordable. |
| Two separate memories | The extension and the web app do not share a corpus. Different origins. |
| A one-word search scores 0.2 and is right | Short queries always score low. Trust the confidence label. |
| `chrome-devtools-mcp` sees no extension tools | That harness does not inject our content scripts into its own pages. Use `pnpm ext:check` or `pnpm ext:relay`. |
| The model download stalls behind Shields | One-time, `huggingface.co`. See Set up. |

---

## Reference

| | |
|---|---|
| Install and use the extension | `extension/README.md` |
| Pick up the code | `HANDOFF.md` |
| What the browser actually does | `lib/webmcp/API-DELTA.md` — 18 findings, each reproduced by running it |
| Why the architecture is shaped this way | `autorag-build-plan.md` AD-5, `amendments.md` A7 |
