# Autorag, the browser extension

A standby capture tool. It sits in the background while you browse. When something
is worth keeping, you keep it where you found it — highlight, or one keystroke.

**You never type a URL. You never paste a link. There is no source field anywhere.**
The page you are on *is* the source; the extension takes the URL, the title and the
text from the tab you are already looking at.

---

## Install it in your Brave (2 minutes)

```bash
pnpm install
pnpm ext
```

Then, in Brave:

1. Go to `brave://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select `extension/dist` in this repo

That's it. It is now running on every tab.

The first capture takes about a minute while a 25MB embedding model downloads once.
The side panel tells you when it is ready. Everything after that is instant, and
nothing ever leaves your machine.

> **Brave Shields** can block that one-time model download from `huggingface.co`.
> If the panel sits on "Loading the embedding model", drop Shields once, reload,
> and put them back up afterwards. Nothing else in the extension touches the network.

---

## Using it

**Keep a passage.** Highlight text on any page. A **Keep** button appears next to
your selection. Click it. Done — it is captured and waiting in your review queue.

**Images.** Right-click one and choose *Keep this image's description*. Autorag indexes
text, so what is stored is the caption, alt text and surrounding paragraph, with the image
URL as its source; an image nothing is said about is refused rather than stored unfindable.

**Without the mouse.** `Ctrl+Shift+K` keeps whatever is highlighted.
`Ctrl+Shift+E` keeps the whole article you are reading, no selection needed.
Change either at `brave://extensions/shortcuts`.

**Right-click.** Select text → *Keep this in Autorag*.

**From the panel.** Click the toolbar icon. The panel shows the page you are on
with **Keep this page** and **Keep selection**, plus everything waiting for review
and a box to ask your memory questions.

Every capture shows a small confirmation in the corner of the page, so a keystroke
is never a silent no-op.

---

## What happens to what you keep

Nothing becomes searchable until you say so. A capture is chunked, embedded
locally, screened against everything you already kept, and put in the review queue.
You approve it or throw it out with a reason — and if the same material shows up
again later, it comes back with your own reason attached.

That review step is the point. It is what makes this a memory with your judgment in
it rather than a pile of everything you ever scrolled past.

---

## The part that is WebMCP

While you browse, the extension registers seven tools on `document.modelContext` of
**every page you visit**:

| Tool | What an agent does with it |
|---|---|
| `autorag_remember_selection` | Keeps what you currently have highlighted |
| `autorag_remember_passage` | Keeps a passage it read on this page |
| `autorag_recall` | Searches everything you have ever kept, from any site |
| `autorag_memory_stats` | How much is kept, pending, rejected |
| `autorag_list_pending` | Reads the review queue, with both sides of anything flagged |
| `autorag_adjudicate_conflict` | Rules on a flagged pair — advisory, and it approves nothing |
| `autorag_list_sources` | Sees what the memory already covers before adding to it |

Approving and discarding are **deliberately absent**. Screening nominates, the agent
adjudicates, you decide — and the third verb belongs to a person, so the only door to
it is the side panel. An agent can rule that two passages do not really conflict; it
cannot act on its own ruling.

Measured: `wikipedia.org` and `example.com` have no `document.modelContext` at all.
The extension gives them one. So an agent driving your browser finds *your* curated
memory as ordinary tools on whatever third-party page it is already reading — with
no integration, no endpoint and no API key.

A vector database cannot do that. It sits behind an API that something has to be
built against. This offers itself to any agent on any page. That is the difference,
and it is WebMCP doing it.

---

## Checking it works

```bash
pnpm ext:check
```

Twenty-four assertions against a real browser with a throwaway profile: a third-party
page gains a WebMCP surface, the seven tools appear on it, a tool call reaches the
corpus, highlighting offers to keep in place, an agent can deposit, **clicking Keep on
a highlight actually stores it**, the memory answers from an unrelated site, an agent
reads the queue and rules on a flagged pair, **that ruling lands where the human will
read it**, an approval tool is not reachable from the page, and the corpus can be
managed.

---

## Known rough edges

- `@mcp-b/global` registers a `page_heading` demo tool of its own, so that shows up
  alongside the seven above on every page. Not ours, not wanted, not yet removed.
- The whole-page extractor is crude: `<article>`, else `<main>`, else the body with
  nav/header/footer/script stripped. It beats asking you to select 2000 words; it is
  not a Readability implementation.
- Captures made while the model is still downloading will wait for it.

---

## How it is put together

Four contexts, because the browser gives none of them all the privileges needed:

| Context | Has | Lacks |
|---|---|---|
| MAIN-world content script | the page, `document.modelContext` | any extension access |
| isolated content script | the page, extension messaging | the page's JS world |
| offscreen document | IndexedDB, the embedding model | any page access |
| side panel | the UI | everything else |

The offscreen document is the only place the corpus exists; everyone else asks it
through the service worker. It exists because a service worker is killed after ~30s
idle, which would evict a 25MB model on every lull.

The RAG core in `src/rag/` is shared with the web app unchanged. One engine, two
ways in.
