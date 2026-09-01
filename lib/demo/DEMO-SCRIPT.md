# Demo script

Under 3 minutes. **Audio required.** Arc is wrong → right, not empty → full: a memory
that fills up is unremarkable, a memory that corrects a wrong answer is not.

**Before you record**
- Load the page and wait for the badge to read **model ready**. Otherwise the first
  30 seconds is a progress bar.
- Have `evals/seed-corpus.json` handy but the corpus **empty** at the start.
- Keep the synthetic sources loaded in a second tab as a fallback if a live page has
  changed.

---

## 0:00–0:20 — The wrong answer

Ask the agent, with the page open and the corpus empty:

> Where can I stream Dune: Part Two right now, and what do critics think of it?

It answers from training data alone — stale, hedged, or wrong, with nothing to cite.

**Say:** "It has no memory of this, and nothing to cite. Watch what happens when we
give it one."

---

## 0:20–1:50 — The agent gathers, the human steers

> Go read the Wikipedia page, the JustWatch listing and both score aggregators for
> Dune: Part Two, and deposit what matters into Autorag.

On screen: the **Agent activity** panel fills with `autorag_ingest_passage` calls in
real time. The **Review queue** fills with staged passages.

The two aggregators disagree — 92% against 79%. Screening catches it and the card shows
a **conflicting figures** badge.

> Adjudicate that conflict.

The agent calls `autorag_adjudicate_conflict` and its verdict appears on the card, with
reasoning, next to the badge.

**Now you take over — this is the shot the whole demo exists for.** Approve the
Wikipedia and Rotten Tomatoes passages. **Reject the secondary aggregator on camera**,
typing a real reason:

> Sampling method weights trade outlets; not comparable to the headline score.

Then mark the JustWatch source stale:

> Streaming availability changes monthly and needs re-verification.

**Say:** "The agent gathered and flagged. I decided. That reason is kept — it comes
back if this source is ever proposed again."

---

## 1:50–2:30 — The right answer, with provenance

Ask the identical question again.

The agent calls `autorag_answer_with_sources` and answers correctly — **citing which
source each claim came from and when it entered the memory**, and noting that the
availability source is marked stale.

**Say:** "Same question. Now it cites where each piece came from, and it knows which
part of its own memory to distrust."

---

## 2:30–2:50 — It persists, and it remembers being told no

Close the tab. Reopen it. The corpus is still there.

Then have the agent try to re-ingest the rejected aggregator. It comes back flagged
against **your own rejection reason**, quoted verbatim.

**Say:** "New session, same memory. And it remembers what I turned down, and why."

---

## 2:50–3:00 — The claim

**Say:** "No server. No API key. No inference cost. The embeddings ran in this tab,
the index lives in this browser, and nothing left the device. The agent is the
generation layer — Autorag only supplies passages and provenance."

---

## If something goes wrong live

| Problem | Recovery |
|---|---|
| A real page changed and the contradiction is gone | Switch to the synthetic set in tab two; the flow is identical |
| Agent stalls mid-harvest | Ingest one passage through the paste form and continue; the queue is the story, not the harvesting |
| Model not warm | Stop. Do not record through a progress bar. |
| Tool missing after a state change | Reload; the always-on group registers on mount |

## Do not say

- **"train"** — nothing is being trained. Say *ingest*, *index*, *memory*, *corpus*.
- **"secure" / "prevents prompt injection"** — the review queue is steering, not a
  security control. Claiming otherwise invites a question you will lose.
