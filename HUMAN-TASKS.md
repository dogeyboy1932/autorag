# Things only you can do

Plain language. Claude cannot do any of these — they need your accounts, your
browser, or your face and voice.

---

## 1. Test the app inside ChatGPT's browser  ⬅ the one you asked about

**What this even is.** ChatGPT has a web browser built into it. When you ask ChatGPT
to go look at a website, it opens that page inside itself. If the page has WebMCP
tools on it — like ours does — ChatGPT can *use* those tools instead of just reading
the text.

**Why it matters for us.** The judges get a link to our live site. Some of them will
open it in Chrome. Some will open it inside ChatGPT. Those are two different browsers
with two different WebMCP implementations. Ours is fully tested in Chrome. It has
**never been tested inside ChatGPT**, so we genuinely do not know if it works there.

**Why you and not Claude.** It needs a logged-in ChatGPT account. Claude has no way
to drive one.

**What to actually do**, once the app is deployed and you have a URL:

1. Open ChatGPT.
2. Paste this, with our real URL swapped in:
   > Open https://OUR-URL-HERE and tell me what tools the page offers you.
3. It should list tools whose names start with `autorag_`. There should be about
   four at first: `autorag_ingest_passage`, `autorag_check_conflicts`,
   `autorag_get_stats`, `autorag_list_sources`.
4. Then paste:
   > Use the autorag_get_stats tool on that page and show me exactly what it returns.
5. It should return a block of JSON with things like `chunk_count` and `model_ready`.

**Tell Claude which of these happened:**
- ✅ It listed the tools and the stats came back → we're fine, nothing to change.
- ⚠️ It listed the tools but calling one failed → copy the error text to Claude.
- ❌ It couldn't see any tools at all → tell Claude; the README has to stop claiming
  ChatGPT support, and that changes what we say in the submission.

**When.** As soon as there's a deployed URL. Do not leave this to the last night — if
it fails, we need time to react.

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
