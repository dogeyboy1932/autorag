# Testing Autorag

Five things to check: **keep**, **review**, **recall**, **ask**, and **cloud memory**.
Everything else in the extension serves one of them.

Autorag is a curated memory that lives in your browser. You keep things while you read, you
decide what stays, and it answers questions from what survived — citing the page each claim
came from.

`pnpm ext:check` proves 46 of these mechanically. The tests below are the ones that need a
person: whether it *feels* right, not whether it returns the right JSON.

---

## Set up

```bash
pnpm install && pnpm ext
```

`brave://extensions` → **Developer mode** → **Load unpacked** → `extension/dist`.
Open the panel with the toolbar icon.

**First capture takes ~1 minute** while a 25MB embedding model downloads, once. The header
tracks it: `downloading model 40%` → `model ready`.

> Never becomes ready? Brave Shields is blocking the one-time download from
> `huggingface.co`. Drop Shields once, reload, put them back.

**If highlights stop working after you reload the extension**, reload the page. The panel
says so rather than blaming the page.

---

## 1. Keep

Highlight a paragraph on any article. A **Keep** button appears beside it — click it, or
press <kbd>Ctrl+Shift+K</kbd>.

Then try, in order:

- **A whole page** — panel → *Preview this page*, trim it, keep it.
- **An image** — right-click → *Keep this image's description*. One with a caption, one
  without.
- **A PDF** — highlight in it. Chrome's viewer can't be read, so you'll be offered
  **"Open it in Autorag's reader"**. Click it, then highlight normally.

**Passes if:** every capture takes one gesture where you already are, and lands in *To
review*. The PDF passage cites the PDF's URL and filename, not `chrome-extension://…`.

**Expected:** an uncaptioned image is staged but can't be approved until you describe it —
its only text would be a URL, and no search would ever match that. A *scanned* PDF has no
text layer at all; nothing can select text that was never text.

---

## 2. Review

Open the panel. Everything you kept is waiting — nothing is searchable yet.

- **Edit** a passage before keeping it. Add a note.
- **Discard** one. Leave the reason blank.
- Keep something that contradicts something you already kept.

**Passes if:** an edited passage is findable by its *new* wording (it re-embeds, not just
re-words). A discard needs no justification. A contradiction gets flagged as a conflict
showing both sides.

**Expected:** screening over-flags. It would rather show you two related passages than
silently merge them.

**Editing something already saved:** search for it in Recall and use **Edit** on the result.
Saving sends it back to *To review* — it was approved as it read then, and changing the text
withdraws that. Re-approve and you have vouched for what it now says. A *discarded* passage
cannot be edited at all: its text is what future screening matches against.

**Discarding one saved passage:** same place — **Discard** on a Recall result. It leaves the
corpus, the rest of its page is untouched, and the reason (optional) is replayed if the same
material comes back. A discard is final: the text stays as something screening matches
against, so it cannot be edited or restored.

**One thing to watch:** an edited passage is out of your searchable corpus until you
re-approve it. Edit several and walk away and they all sit in the queue — the header count
is the only thing that will tell you.

---

## 3. Recall

Search **Recall** for something you kept a while ago. Try one word, a full question, and a
typo.

**Passes if:** you get passages with the URL and date each came from, plus a confidence
label.

**Expected:** a one-word search scoring 0.2 and being right. Short queries always score low
— trust the **confidence** label, not the number.

**Tell me if:** something you know is in there doesn't come back for a reasonable question.
That's the retrieval failure I most want examples of.

---

## 4. Ask — the RAG agent

Panel → **Answering model** → paste an Anthropic API key, pick a model. Then ask Recall a
real question, ideally one spanning two different things you kept.

**Passes if:** an answer appears above the passages, written from them, with `[1]`, `[2]`
citations matching the numbered sources below it.

**Then ask about something you never kept.** It should say so plainly instead of answering
from general knowledge. That refusal is the product working.

**The test that matters:** close Claude Code, stop every other tool, ask again. Autorag
answers on its own.

**Answers should be complete, not just short.** If the passages list ten steps you should
get ten. If a reply ever ends with *"cut off at the length limit"*, that is the ceiling
being honest rather than the answer being finished — tell me, because the limit is generous
now and hitting it means something is wrong.

**Cost:** a few thousand tokens per answer — well under a cent on Opus 5. The panel prints
each model's rate. Nothing calls the model unless you ask.

**Privacy, precisely:** your question and the retrieved passages go to the provider.
Capture, review, embedding, indexing and search stay local. Remove the key and Autorag is
exactly what it was — the header line under the counts tracks this and stops saying
"Nothing is uploaded" once that is no longer true.

**Images are shown to the model, not just described to it.** If a kept image contains the
answer — a definition, a chart, a diagram — Ask reads the picture itself. The stored
description is only what made it findable; it is often a filename and nothing more.

**Tell me if:** it asserts something the passages don't support. That's the failure the
whole design exists to prevent.

### 4b. Remember — follow-up questions

Tick **Remember this conversation**, ask something, then ask a follow-up using a pronoun:
*"and the second one?"*, *"why does that matter?"*

**Passes if:** the follow-up is understood, and the answer line says what it actually
searched for — a rewritten standalone query, not your pronoun. Citations still point at
passages, never at the previous answer.

**Off by default, on purpose.** Carrying the conversation makes follow-ups work; it also
lets the model lean on its own earlier prose instead of the passages, which is a quiet loss
of citation integrity rather than a visible error. The turn count and running token total
sit beside the checkbox, with **Clear** to reset.

**Tell me if:** an answer cites something that was never in the passages for *that* turn.

---

## 5. Cloud memory — off one device

*Default is local: free, offline, nothing leaves this machine.* This is opt-in.

**One-time setup**, in this order — steps 2 and 3 are the ones that bite:

1. Create a free Supabase project. Copy its **URL** and **anon public** key into the panel.
2. Supabase → **SQL editor** → run the script the panel shows under *setup steps*.
3. Supabase → **Authentication → Sign In / Providers → Email** → turn off **Confirm email**.
   An extension has no address for a confirmation link to come back to; left on, the link
   points at `localhost:3000` and you get `otp_expired`.
4. In the panel, **Create account** with any email and password. **This is a user inside
   your project — not your supabase.com login**, which does not exist there and will fail
   with "Invalid login credentials".
5. **Sync now.**

Then: open Autorag in a **different browser profile**, sign in with the same email, **Sync
now**, and search for something you kept in the first one.

**Passes if:** it is there, with its source URL. Then forget a source in the second profile,
sync both, and confirm it stays gone in the first — a resurrected passage is the failure
this is really testing.

**Sync runs on its own.** Signing in pushes what is already here; every change after that
schedules a push a few seconds later. **Sync now** is a manual nudge, not the only trigger.
Watch the **Activity** feed — a failed sync is reported there, loudly, because a silent one
looks exactly like a memory that is safely backed up and is not.

**Expected:** the first sync of a large corpus is one long upload; the Activity feed reports
each stage. Ranking still runs locally, so search speed is unchanged either way.

**Cloud mode uploads your whole corpus** — everything ever kept, not just what a question
retrieves. That is a bigger step than the answering key and the panel says so before you
connect.

**Tell me if:** anything you deleted comes back.

---

## Also worth a minute

- **Cross-site** — keep something on site A, then on unrelated site B ask an agent driving
  your browser what it knows. It should recall A and cite it.
- **Panel width** — drag the panel narrow. Elements shrink; nothing scrolls sideways.
- **Stale vs forget** — *Manage corpus* → mark a source out of date (demoted, still
  findable) vs forget it (gone).
- **Activity** — the feed should explain what is happening during the model download and
  any slow capture.

---

## Tested by hand — reported passing on 2026-09-03

Everything in sections 1–5 was walked through against a live setup, including **cloud sync
and Supabase auth against a real project**. What follows is what remains genuinely
unexercised — and note the distinction: `ext:check` proves mechanism, a person walking
through it proves the product. Neither substitutes for the other.

## Still not exercised

Each is invisible to `ext:check` because it needs real time, real volume, or a second
party.

- **It survives a restart.** Keep and approve something, quit the browser completely,
  reopen. The corpus should be intact and searchable. Still the claim the whole product
  rests on, and worth re-checking after any storage change. Your database is real and on disk:
  `~/snap/brave/current/.config/BraveSoftware/Brave-Browser/Default/IndexedDB/chrome-extension_<id>_0.indexeddb.leveldb`.
  To look inside it, open the panel as a tab → F12 → Application → IndexedDB → `autorag`.
- **It survives being left alone.** Leave the browser open a few hours, then highlight
  something and press Keep. MV3 stops the service worker after ~30s idle and can reclaim the
  offscreen document under memory pressure. If capture works at 9am and silently fails at
  3pm, this is why.
- **Answers stay complete on long lists.** Ask something whose answer is a ten-step
  procedure, especially one read out of a diagram. It should give all ten. If a reply ends
  with *"cut off at the length limit"*, the ceiling is being honest — but the ceiling is
  generous now, so hitting it means something else is wrong.
- **It stays usable as it fills up.** Get to 100–200 passages and check Recall is still fast
  and the queue still scrolls. Search loads the whole corpus into memory and ranks it
  (`allChunks()` in `src/rag/store.ts`) — fine at this size, worth knowing where "fine" stops.
- **Forget everything actually forgets.** *Library → Sources → Erase the whole corpus.*
  Confirm the counts go to zero, restart the browser, confirm they are still zero. In cloud
  mode, confirm the other device does not hand it all back.
- **An agent can curate.** Three of the seven WebMCP tools exist only for this — read the
  queue, see both sides of a flagged pair, rule on it. Probes exercise them; no person has.
  Needs an agent driving the *browser*; the desktop-MCP path was removed.
- **The web app still works.** `pnpm dev` → `localhost:3111`. It registers its own
  `autorag_*` tools and the extension used to collide with them there. It should now stand
  down on that page: the app's own tools, no duplicates, no console errors.

---

## What is automated

```bash
pnpm typecheck && pnpm ext && pnpm ext:check   # 46/46 against real Brave
pnpm ext:sync                                  # two profiles: memory crosses, deletions stick
pnpm bench                                     # retrieval: 21/21 top-1
```

`ext:check` covers, among others: a third-party page gains a WebMCP surface it never had;
capture, approval and recall round-trip with provenance; an agent can read the review queue
but cannot approve; the PDF reader's text layer is selectable and cites the PDF; Ask stays
grounded and never leaks the API key.

`pnpm bench` needs `pnpm dev` running.

---

## Known limits

- **Scanned PDFs** need OCR. Not built.
