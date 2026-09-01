# Things only you can do

*(For picking up development, see `HANDOFF.md`. For how the app works, see `MANUAL.md`.)*

Plain language. Claude cannot do any of these — they need your accounts, your
browser, or your face and voice.

---

## 1. ~~Test the app inside ChatGPT's browser~~ — DEFERRED

**Decision (Aug 31): skipped.** We target Chrome only.

The docs now say plainly that Chrome 151 is the tested surface and that other WebMCP
hosts are untested, rather than implying coverage we never checked. Nothing is blocked
on this.

If you ever want to revisit: deploy, open ChatGPT, and ask it to open the URL and list
the tools the page offers. Names starting with `autorag_` mean it works.

---

## 2. Record the video

Under 3 minutes, **audio required**. Claude will write you a shot-by-shot script with
the exact things to type, so you won't have to improvise.

Budget 2–3 hours. It always takes longer than expected. Two things to do before you
hit record:

- Load the page once and let the embedding model finish downloading (the badge turns
  green and says "model ready"). Otherwise your first 30 seconds is a progress bar.
- Have the corpus already seeded, so you're demonstrating, not waiting.

---

## 3. Push the repo to GitHub

Claude will write the LICENSE and README and prepare the commit, but will not push
anything without you asking. The submission requires the repo be **public** and the
MIT license visible in the "About" panel on the right side of the GitHub page.

---

## 4. Deploy it

You have a Vercel account. The app is a static export, so Netlify would work too if
you'd rather stay on familiar ground. Claude will prepare the config; the login is
interactive so you have to run it.

Tip: in Claude Code you can type `!` followed by a command to run it in the session,
e.g. `!vercel login`, and the output lands in the conversation.

---

## 5. Submit on Devpost

You're already registered. ✅ The submission itself still needs:

- the live URL
- the public repo link
- the video link
- the written description (Claude will draft this, answering all four required
  questions verbatim)

Submit with time to spare. Uploads fail at the worst moment.
