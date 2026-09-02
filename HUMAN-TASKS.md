# What you need to do

Everything here needs your hands, your accounts, or your judgement. Ordered by when
you'll want it.

**Deploy is not on this list any more.** See the last section for why.

---

## 1. Install the extension (2 minutes, do this first)

```bash
pnpm install
pnpm ext
```

In Brave: `brave://extensions` → **Developer mode** (top right) → **Load unpacked** →
select `extension/dist`.

It now runs on every tab. Nothing to start, no server.

**First capture takes about a minute** while a 25MB embedding model downloads once. The
side panel header shows `downloading model 40%` → `model ready · wasm`. It is cached
after that.

> **If it never becomes ready:** Brave Shields is blocking the one-time download from
> `huggingface.co`. Drop Shields for that request once, reload, then put them back up.
> Nothing else in the extension touches the network — you can confirm that in the Network
> tab afterwards.

---

## 2. Use it for ten minutes

This is the part I cannot do for you, and it is the only way to find what's wrong.

Browse normally. When something is worth keeping:

| | |
|---|---|
| **Highlight it** | A **Keep** button appears by your selection. Click it. |
| **`Ctrl+Shift+S`** | Keeps the highlight without touching the mouse. |
| **`Ctrl+Shift+E`** | Keeps the whole article, no selection needed. |
| **Right-click** | *Keep this in Autorag* |

Change either shortcut at `brave://extensions/shortcuts` if they clash with something.

Then open the side panel (toolbar icon). Five sections:

- **Reading now** — the current tab, with *Preview this page* / *Preview selection*.
  Whole-page capture shows you the extracted text in an editable box first; trim it
  before keeping.
- **To review** — nothing is searchable until you approve it here. Discarding asks for a
  reason, and that reason comes back if the same material shows up again.
- **Recall** — ask your memory something. Returns passages with sources, not an answer.
- **Manage corpus** — every source, with *Mark out of date* (stays searchable, ranks
  lower) and *Forget* (permanent, asks twice).
- **Activity** — what the engine is doing, so an empty corpus doesn't look broken.

**What to watch for and tell me:** anything that costs more than one gesture, anything
that happens silently, anything where you couldn't tell whether it worked.

---

## 3. Try the desktop-agent bridge (5 minutes)

This is the piece that makes it more than a private notebook — your own MCP client
searching what you kept while browsing.

```bash
pnpm bridge          # serves http://localhost:3210
```

Open `http://localhost:3210` in the browser where the extension is installed and **leave
the tab open**. It will say `4 memory tools exposed to your desktop agent`.

Then point any MCP client at the relay. For Claude Desktop or Cursor:

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

**Why the odd extra tab.** Two measured limits, both in `lib/webmcp/API-DELTA.md`: a
`ws://127.0.0.1` socket cannot be opened from an `https://` page (D16), and WebMCP refuses
tool registration on a `chrome-extension://` origin (D17). A page served over plain http
on localhost is the only context that is neither. If you want this to feel less strange
later, the fix is extension or native messaging instead of a loopback socket.

Verify it yourself any time: `pnpm ext:relay` → 6/6.

---

## 4. Record the demo

Script is `lib/demo/DEMO-SCRIPT.md`, **but it is still written for the web app and needs
redoing for the extension.** That is on my list, not yours.

Before you record:

- [ ] `pnpm ext && pnpm ext:check` → 13/13
- [ ] Load the extension and let the model finish downloading — never record a progress bar
- [ ] Start with an **empty** corpus; the arc is wrong → right
- [ ] Brave fully quit, then relaunched with `--enable-features=WebMCP` if you want to
      show native WebMCP rather than the polyfill
- [ ] Shields down for `localhost`, or the model already cached
- [ ] `pnpm bridge` running with its tab open, if the desktop-agent beat is in the video

---

## 5. Push the repo

```bash
gh repo create autorag --public --source=. --remote=origin --push
```

`gh` is authed as `dogeyboy1932`. It must be **public** for the MIT licence to appear in
GitHub's About panel. I am blocked from running this — publishing is your call.

---

## 6. Submit on Devpost

`SUBMISSION.md` has the draft with all four required questions answered, **but it is
written with the web app as the headline and needs the extension moved to the front.**
Also mine, not yours.

You will need: the repo link, the video link, and the written description.

---

## Why deploy is no longer on this list

I put it on the previous version of this file and over-justified it. Being straight about
it:

The deploy existed for **one** reason — ChatGPT's in-app browser is the only shipping
WebMCP consumer, it can visit a URL, and it cannot run an extension. That argument only
holds if the demo agent is ChatGPT's browser. **You chose chrome-devtools-mcp**, which
reaches `localhost:3111` perfectly well, so the deploy buys nothing for the demo.

The one thing that might still require it is Devpost asking for a live project URL. I do
not actually know whether it does — I assumed it earlier and wrote a "Live URL" field into
`SUBMISSION.md` on that assumption. Check the submission form; if it insists on a URL,
deploy then (`pnpm build` already emits a clean static export, and `pnpm loop --url <deploy>`
confirms the tool surface survived hosting). Otherwise skip it.

Nothing about the extension needs hosting. Extensions are installed, not deployed.

---

## Known rough edges — expected, not broken

Say these out loud rather than hoping nobody notices.

| | |
|---|---|
| **An agent cannot help you curate yet.** | On the extension, agents get 4 tools: remember selection, remember passage, recall, stats. They cannot see the review queue, adjudicate a conflict, or list sources. The web app has all of that; the extension does not yet. This is the biggest app-side gap. |
| `page_heading` appears on every page | `@mcp-b/global` registers a demo tool of its own. Not ours, not wanted, not yet stripped. |
| Whole-page extraction is crude | `<article>`, else `<main>`, else body minus nav/header/footer. Beats selecting 2000 words; not a Readability implementation. |
| Screening misses some real conflicts | It nominates, you rule. One measured miss scored 0.659 cosine against a 0.72 same-subject threshold. |
| Two separate memories | The extension and the web app do not share a corpus — different origins, and IndexedDB does not cross origins. Accepted, not an oversight. |
| A one-word search scores 0.2 and is right | Short queries always score low. Trust the **confidence** label, not the number. |

---

## Reference

| | |
|---|---|
| Install and use the extension | `extension/README.md` |
| Pick up the code | `HANDOFF.md` |
| What the browser actually does | `lib/webmcp/API-DELTA.md` — 17 findings, all verified by running them |
| Why the architecture changed | `autorag-build-plan.md` AD-5, `amendments.md` A7 |
