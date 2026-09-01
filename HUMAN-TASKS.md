# What to do from here

**The product is the browser extension.** Install it, browse, keep things.
There is nothing to deploy and no URL to type anywhere.

Full guide: **`extension/README.md`**.

---

## 1. Install it (2 minutes)

```bash
pnpm install
pnpm ext
```

In Brave: `brave://extensions` → **Developer mode** on → **Load unpacked** →
select `extension/dist`.

It now runs on every tab. Nothing to start, nothing to open, no server.

**First capture takes about a minute** while a 25MB embedding model downloads
once. If it never finishes, Brave Shields is blocking `huggingface.co` — drop
Shields once, reload, put them back. Nothing else touches the network.

---

## 2. Use it

Browse normally. When something is worth keeping:

| | |
|---|---|
| **Highlight it** | A **Keep** button appears next to your selection. Click it. |
| **`Ctrl+Shift+S`** | Keeps the highlight, no mouse. |
| **`Ctrl+Shift+E`** | Keeps the whole article, no selection needed. |
| **Right-click** | *Keep this in Autorag* |

Each one confirms in the corner of the page. Click the toolbar icon for the side
panel: what you are reading, what is waiting for review, and a box to ask your
memory questions.

Nothing becomes searchable until you approve it in that panel. Rejecting
something with a reason means the reason comes back if the same material shows up
again later.

---

## 3. Check it works

```bash
pnpm ext:check     # 7/7 against a real Brave, throwaway profile
```

The assertion that matters: a real highlight, a real click on **Keep**, and the
text is actually stored. It also proves the WebMCP claim — that `example.com` and
`wikipedia.org` have no `document.modelContext` at all, and the extension gives
them one carrying your four memory tools.

---

## 4. The one test nobody has run

Everything so far is driven by a script naming tools directly, or by someone who
already knows what the descriptions mean. So this is still unproven:

> An agent, seeing only the tool descriptions, picks the right tool with the right
> arguments.

That is what MCP is for, so it is the claim the whole thing rests on.

**How:** open a fresh agent session with no context about this project, point it at
a page with the extension installed, and say only *"save something useful from this
page."* Watch which tool it reaches for and whether it invents arguments.

A wrong tool choice is a **description bug, not an agent bug** — fix the wording in
`extension/src/content/webmcp.ts`. That is the highest-value edit left.

---

## Known rough edges

| | |
|---|---|
| `page_heading` appears on every page | Registered by `@mcp-b/global`, not us. Not yet stripped. |
| Whole-page capture is crude | `<article>`, else `<main>`, else body minus furniture. Beats selecting 2000 words; not a Readability implementation. |
| Captures during model download queue | They complete once it is ready. |
| Screening misses some real conflicts | It nominates, you rule. One measured miss scored 0.659 against a 0.72 same-subject threshold. |

---

## The old web app

`pnpm dev` still serves the original Next.js dashboard at `localhost:3111` — the one
with the Source URL field. **It is not the product and does not need deploying.**

It is worth keeping for one reason: it is the reference WebMCP tool surface, with 15
tools, both registration APIs, and 15 verified findings behind it
(`lib/webmcp/API-DELTA.md`). Its own suites still pass:

```bash
pnpm bench     # retrieval quality — 21/21, 3/3, 25/25
pnpm loop      # its WebMCP surface — 15/15
```

Ignore any instruction anywhere telling you to deploy it or to run
`pnpm loop --url https://…`. That was written before the pivot; there is no deploy
and you do not need one.

---

## Reference

| | |
|---|---|
| Install and use the extension | `extension/README.md` |
| How the code fits together | `HANDOFF.md` |
| What the browser actually does | `lib/webmcp/API-DELTA.md` — 15 findings, all verified by running them |
| Recording a demo | `lib/demo/DEMO-SCRIPT.md` (written for the web app; needs redoing for the extension) |
