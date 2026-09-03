# Handoff — read this first in a new session

**Autorag** is a curated retrieval memory that lives in the browser. You keep things while
you read, you decide what stays, and it answers questions from what survived — citing the
page each claim came from.

**Branch:** `main`, clean, pushed to <https://github.com/dogeyboy1932/autorag> (public, MIT
detected in the About panel). **Last worked:** 2026-09-03 (hackathon day; submitted with an
extension).

```bash
pnpm install && pnpm ext
# brave://extensions → Developer mode → Load unpacked → extension/dist
```

Reload the extension there after any build. The side panel opens from the toolbar icon, or
as a full tab — which is the better way to work on it:

```
chrome-extension://obeilcdjggcekgfmiiadlcmfdhifajob/sidepanel.html
```

That id is stable while the extension is loaded from the same `extension/dist` path; it is
derived from the directory, not random. `pnpm ext:watch` stamps a build id that the panel
polls, so that tab live-reloads on every rebuild. **Panel-only changes appear instantly;
service worker, content script and offscreen changes still need a manual extension reload.**

**Things the author has that this document cannot contain**, and that a new session should ask
for rather than guess:

| | |
|---|---|
| Netlify live URL | **<https://autorag-web.netlify.app/>** — live, auto-deploys from `main` |
| Owner Supabase project | in `.env` (gitignored) — schema applied, RLS verified. See §0. |
| Directory Supabase project URL + anon key | **still not created** — Step 3 |
| `ANTHROPIC_API_KEY` for the demo function | env var on Netlify, never in the repo |
| Demo session join code | generated once the directory exists |

**`.env` is gitignored and has never been committed** — verified against every commit, not
just the tip. It holds `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` and
`SUPABASE_JWKS_URL`; `.env.example` documents what each is for without the values. Nothing in
the code reads them yet — the extension takes its cloud config from the panel's Settings tab.

**The secret key must never reach a browser.** None of these carry the `NEXT_PUBLIC_` prefix,
so Next cannot inline them into the static export even if they are set in Netlify's UI, and
that is the only thing standing between the service key and a bundle anyone can read. When
Step 4 adds `netlify/functions/ask.ts`, a Function is the first place in this project where a
secret can legitimately be read — do not let the habit leak back into `app/`.

A screenshot preview of the current UI is published at
`https://claude.ai/code/artifact/5a80e800-b470-4170-85ec-00a3f83af65c`, and PNGs are in
`~/Desktop/autorag-preview/`. To regenerate them, drive `sidepanel.html` with puppeteer the
way `probes/extension-check.mjs` does.

---

## 0. State of play

| | |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm ext:check` | **48/48** against real Brave, throwaway profile |
| `pnpm ext:sync` | passes — corpus crosses two browser profiles, deletions stick |
| `pnpm bench` | 21/21 top-1 · 3/3 no-overclaim · 25/25 no-withhold (needs `pnpm dev` running) |
| `pnpm build` | static export clean; `out/` carries the extension zip and the meta tag |
| the web app | driven by hand at last — **0 console errors**, 5 tools on `document.modelContext` |
| HUMAN-TASKS | reported passing by hand for the **pre-session** build. **Rewrite it after Step 5 — see Step 6.** |

**Step 1 and the whole of Step 2 are done.** The working tree is clean and
<https://autorag-web.netlify.app/> is live, auto-deploying from `main`. **Step 3 is next.**

Verified against the deployed site rather than assumed:

- **0 console errors, page errors and failed requests**, both with the extension loaded and
  without it. 5 `autorag_*` tools, no duplicates — so the stand-down holds on the real origin,
  not just on localhost.
- **The embedding model loads** (`model ready · wasm`), which is the live confirmation that
  leaving COOP/COEP off was right. With them on, this is the line that would have hung.
- **`netlify.toml` is being applied** — the zip comes back with the `Content-Disposition` and
  `Cache-Control` set there.
- **The downloadable zip is byte-identical to the local build**, `unzip -t` clean, and extracts
  to exactly the `extension/dist` that passed 48/48. What a judge downloads is what was tested.

**Missing, and it is a Step 4 item rather than a regression:** the page has no link to
`/autorag-extension.zip`. The file is served correctly; nothing points at it yet.

Two things were confirmed by driving the built `out/` in a real browser, both of which the
previous session had flagged as unverified:

- **The tool-name collision is genuinely fixed.** With the extension loaded on the web app's
  own page, the surface still holds exactly 5 `autorag_*` tools, no duplicates, and no
  `Tool already registered` anywhere in the console.
- **The web app is clean on load.** Zero console errors, zero page errors, zero failed
  requests. It was never once opened by hand before today.

One piece of console noise that is **not** a bug and should not be chased: on an `http://`
origin the content script injects the local relay's embed, which opens a WebSocket to
`ws://127.0.0.1:9333` and logs a failure when no `pnpm bridge` is running. It is skipped
entirely on `https://` (D16), so it cannot appear on the deployed site — only on
`localhost` during development.

---

## 1. What this thing actually is

Five surfaces, one engine (`src/rag/`).

- **Capture** — highlight anything on any page → a Keep button appears → one click.
  `Ctrl+Shift+K`, right-click for images, whole-page preview, and a built-in PDF reader.
- **Review** — nothing is searchable until a person approves it. Screening flags duplicates
  and contradictions and shows both sides.
- **Recall** — hybrid retrieval: cosine fused with BM25 at `LEXICAL_WEIGHT = 0.4`, stale
  sources demoted by `STALE_PENALTY = 0.6`.
- **Ask** — a conversation. Retrieves locally, then a model writes a cited answer from those
  passages and nothing else. Opt-in, the user's own key.
- **Memory** — local by default; optionally mirrored to the user's own Supabase project so
  the corpus follows them across machines.

Everything runs on the device except Ask (the question and its retrieved passages) and
cloud sync (the corpus, if enabled). Both are opt-in and the panel footer says which.

---

## 2. Final judgement on WebMCP — read this before writing any pitch

**Autorag does not depend on WebMCP.** Capture, review, retrieval, generation and cloud
sync all work with every line of WebMCP code removed. The PDF reader proves it by accident:
it has *zero* WebMCP tools and full capture, because capture runs on
`chrome.runtime.sendMessage`.

**What WebMCP does here, precisely:** `content/webmcp.ts` registers 7 tools on
`document.modelContext` of every page you visit, so a program *other than Autorag* can call
your memory. That is the whole of it.

**Who calls them today:** Chrome's built-in agent, `chrome-devtools-mcp`, the MCP-B
extension. The desktop-MCP relay path existed and was deliberately deleted — the marginal
value did not justify a per-session process (see §6).

**The defensible framing, which does not overclaim:**

> Autorag is custom WebMCP tooling plus the storage and judgment layer that tooling needs.
> The agent drives; the memory and the human decide.

Two things are genuinely Autorag's and cannot move into an agent:

1. **The engine.** An agent can call `autorag_recall`; it cannot *be* the index — chunking,
   embeddings, hybrid ranking, screening, provenance.
2. **The human loop.** `approve` and `reject` are **deliberately absent** from the tool
   surface. An agent nominates and adjudicates; a person decides. `ext:check` asserts the
   absence, so it cannot be added by accident.

One non-obvious true claim worth keeping: most pages have no `document.modelContext` at all
(measured `undefined` on wikipedia.org). Autorag ships the polyfill, so it does not merely
use WebMCP where it exists — it puts a WebMCP surface on pages that never had one.

**Do not claim Autorag requires WebMCP.** It is checkable in thirty seconds and it is false.

---

## 3. Built today — the whole list

**PDF reader** (`extension/src/reader/`). Chrome renders PDFs through PDFium, whose text
reaches no DOM: `getSelection()` returns `''` even inside the viewer's own frame, read over
CDP. So Autorag renders PDFs itself with pdf.js; the text layer is ordinary DOM and every
capture path works unchanged. Opt-in per document. ~5.9MB of vendored pdf.js.

**Ask** (`extension/src/offscreen/answer.ts`). Grounded, cited answers in the panel — no
Claude Code, no MCP client. Streams; images are inlined as evidence (capped at 2 per answer
for cost); Haiku gets different parameters because it rejects adaptive thinking and
`effort`.

**Remember mode.** Multi-turn as a toggle, off by default. On, it rewrites the follow-up
into a standalone query before retrieving ("and the second one?" → "tidal power
predictability") and re-grounds every turn.

**Cloud memory** (`src/rag/sync.ts`). Mirrors to Supabase; IndexedDB stays the only thing
anything reads from, so retrieval, offline use and the benchmark are untouched. Tombstones
for deletions. Session auto-renews on `JWT expired`.

**Edit and discard for saved passages.** Editing an approved passage returns it to the
review queue (approval is withdrawn, not silently overwritten). Discarding removes one
passage without losing the rest of its source.

**UI rebuild.** Three tabs (Ask / Library / Settings). Ask is a real chat: scrolling
transcript, pinned composer, sources in a bottom drawer, thread persisted across panel
closes.

**Relay deleted.** It was wedging the offscreen document against a dead port and taking
capture down with it.

---

## 4. Findings that cost real time — do not re-learn these

Full detail in `lib/webmcp/API-DELTA.md` (19 findings) and `amendments.md` (A1–A13).

- **D19 — a PDF's text is in no DOM at all.** Not a permissions problem. No manifest key
  fixes it. Rendering it yourself is the only route.
- **The CORS header is required.** `anthropic-dangerous-direct-browser-access: true`. It was
  briefly omitted because a spike from `sidepanel.html` returned 401 with and without it —
  but the call ships from the **offscreen document**, and an adjacent context is not the
  production path.
- **`tab.url` is `undefined` for the extension's own pages** without the `tabs` permission.
  Detecting the reader that way silently worked or didn't depending on how the tab was
  focused. Route by try-content-script-then-broadcast instead.
- **pgvector wants a string**, `'[0.1,0.2,…]'`, not a JSON array. The stubbed Supabase in
  `sync-check.mjs` accepted either; only a live project surfaced it. The stub now refuses
  what Postgres refuses.
- **A wedged relay holds its listening socket and accepts nothing.** Port discovery queues a
  connection on every sweep and never gets one back.
- **Haiku 4.5 rejects `output_config.effort`** and has no adaptive thinking mode.

**The most expensive lesson of the day, and it happened three times:** a check that passes
without exercising its claim is worse than no check. A discard test that reused an
already-approved chunk (so `reject` was a silent no-op); a sibling-survival test whose two
paragraphs chunked into one passage; a clipping test that measured a `display: none` pane
and got 0×0. All green, all vacuous. **When a check passes, confirm it measured something.**

And the single most costly bug: **`.text` had `max-height: 7.5em; overflow: hidden`.** A
complete ten-step answer displayed three. That was chased through `max_tokens`, `effort` and
the system prompt before anyone looked at the CSS. The model was never wrong.

---

## 5. Architecture rules — do not regress these

1. **Approve and reject are not tools.** An agent nominates and adjudicates; a person
   decides. Asserted by `ext:check`.
2. **IndexedDB is the only read path.** Cloud is a mirror. Moving ranking server-side means
   re-implementing hybrid fusion in SQL — `ts_rank_cd` is not BM25 — and a second ranker
   that quietly disagrees with the first is worse than none.
3. **Every tool result goes through the `CallToolResult` envelope** (D12). A bare object
   arrives empty at the agent and nothing reports it.
4. **Answers are grounded or absent.** The model answers only from this turn's passages,
   cites each claim, and says so when the memory holds nothing. Citation numbers are
   per-turn; conversation recall gets no bracket number.
5. **Messages name the cause they measured, not a guess.** This repo has repeatedly shipped
   a sentence that was true about the string it checked and wrong about why — "under 50
   characters" for an unreadable PDF selection, "check your key" for an expired token,
   "nothing is highlighted" for a page that cannot be read. If a component can only see one
   layer of a failure, report the observation, not the cause.

---

## 6. What is left — the plan, concretely

**Two hard submission requirements are currently unmet: no live URL and no public repo.**
Steps 1–2 fix both, and nothing after them matters until they are done. A browser extension
has no URL, and the brief says *"build a WebMCP-powered web app"* — so `app/` is not a
footnote to hide, it is the deliverable. The extension is what makes the entry interesting,
which the rules explicitly allow: a pre-existing project must be *"meaningfully extended
using WebMCP"*, and putting a WebMCP surface on every page a person visits is exactly that.

**Standing decisions**, so they are not relitigated:

- **Netlify** hosts the web app. That URL is what gets submitted.
- **Every user keeps their own Supabase project**, so corpora stay private. A small
  **directory project** the author hosts is what makes them findable.
- **A session is a shared doc, not a shared account.** You can hold a dozen sessions and
  invite someone into one.
- **Demo mode gives judges full management**, including destructive verbs. Assume the corpus
  gets emptied; reseed it.
- **A web page cannot install an extension on click** — inline install was removed in Chrome
  71. It is a zip download plus three lines of instructions.

### Step 1 — Finish committing — **DONE**

Five commits rather than the four planned. The plan grouped `probes/extension-check.mjs`
with the stand-down change, but that file's 726 new lines test Ask, the PDF reader and
edit/discard and have nothing to do with standing down, so it got its own commit.

### Step 2 — Make the submission valid

**a. Public repo — DONE.** <https://github.com/dogeyboy1932/autorag>, public, MIT showing in
the About panel. History was scanned for secrets before it went up; only
`.env.local.example` was ever committed and it holds no keys.

**b. The literal API call — DONE.** Both call sites now say
`document.modelContext.registerTool(...)` by name: `src/webmcp/registry.ts` for the web app
and `extension/src/content/webmcp.ts` for the every-page surface. The `navigator` arm stays
as the fallback it always was (D1).

Two things worth knowing before touching it again. The whole tool object goes up, **not** the
four fields the spec's example shows — these tools carry `title` and `annotations` and
destructuring `{ name, description, inputSchema, execute }` to match an example would quietly
drop them. And `types/webmcp-dom.d.ts` now declares `modelContext` on `Document` and
`Navigator`, because lib.dom has no such property and every reference used to be an
`as unknown as` cast — which would have left the one call that matters unchecked.

**c. Zip the extension — DONE.** `pnpm ext:zip` → `public/autorag-extension.zip`. 225 files,
80.0MB → 20.7MB.

It is **gitignored and built during the deploy**, not committed: a 20MB binary in git would
be re-committed on every extension change and would ship stale the first time someone forgot.
`netlify.toml` runs `pnpm ext && pnpm ext:zip && pnpm build`, and that order is load-bearing —
the zip must exist in `public/` before the export copies `public/` into `out/`.

`extension/zip.mjs` writes the archive itself rather than shelling out to `zip` (a binary the
build image might not have) or pulling in an archiver for one file. It was verified rather
than assumed, because a hand-written archive is exactly the thing that can be malformed and
still look right: `unzip -t` reports no errors and `diff -r` of the extracted tree against
`extension/dist` is empty — so the download is byte-for-byte the build `ext:check` ran on.

**d. Deploy to Netlify — the one thing outstanding.** `netlify.toml` is committed and carries
the build command, publish dir (`out`) and `NODE_VERSION = "22"` (pinned because `zip.mjs`
uses `zlib.crc32`, which landed in 20.15). Connect the repo at netlify.com and the settings
are picked up with nothing to type.

**Do not add COOP/COEP headers** as a routine hardening pass. They would buy SharedArrayBuffer
and threaded WASM and would also block the cross-origin Hugging Face fetch that downloads the
embedding model, because that CDN sends no CORP. The app would come up looking perfectly
correct and simply never finish loading its model. `netlify.toml` says so in place.

**Claim the site name first**; Step 4 needs the real origin in the manifest's
`externally_connectable`, and the zip has to be rebuilt after it is set.

---

### Step 3 — Sessions (~4h)

A **session** is a corpus several people share. Everyone keeps their **own** Supabase project,
so corpora are private by default; a small **directory project you host** makes them findable.

#### What already exists, measured rather than assumed

The project in `.env` is an **owner project — not the directory.** Probed over PostgREST:

| table | anon (publishable key) | admin (secret key) |
|---|---|---|
| `sources` · `chunks` · `deletions` | `200 []` | `200`, **2 rows each** |
| `sessions` · `profiles` · `invites` · `demo_usage` | `404 PGRST205` | `404` |

Two things follow, and the second is the one that saves time.

**`SCHEMA_SQL` is already applied and RLS genuinely works.** Admin sees 2 rows where anon sees
none — which is proof, where `200 []` on an empty table would have been the same vacuous green
this repo has shipped three times before. There is a small real corpus in there; do not treat
it as scratch.

**The directory does not exist.** All four of its tables 404, so every line of the SQL below
still has to be run, in a **second** project.

**Keep them separate, and this is a security property rather than tidiness.** A join code
hands someone your project's publishable key. If the directory tables lived in the same
project, that key would also address `profiles` — the table holding *other people's* Supabase
credentials — and the only thing between them would be RLS policies that §"Known limit" below
already admits are imperfect for shared sessions. Two projects means the corpus key cannot
name the credential table at all.

#### The API keys are the new scheme, and it matters

This project issues `sb_publishable_…` / `sb_secret_…` with a JWKS URL, not the legacy
`anon` / `service_role` JWTs. Checked rather than assumed, because it would have been a
confusing failure to discover halfway through Step 3:

- **The existing `sync.ts` works unchanged.** Its `apikey` + `Authorization: Bearer` headers
  authenticate fine with a publishable key — a live `select` on `sources` returned 200.
- `auth.uid()` and `auth.jwt() ->> 'email'` still behave as the policies below expect; they
  read the request's JWT, and asymmetric signing does not change that.
- One asymmetry to know: the OpenAPI root (`/rest/v1/`) now **refuses** a publishable key
  ("Only secret API keys can be used for this endpoint"), so introspecting the schema is not
  something client code can do any more. Query a table to test reachability instead.

#### Directory project (yours) — run once, in a NEW project

```sql
create table profiles (
  user_id uuid primary key references auth.users(id),
  email text not null,
  project_url text,          -- their own Supabase
  anon_key text,
  created_at timestamptz default now()
);

create table sessions (
  code text primary key,     -- short, shareable
  owner_user_id uuid not null references auth.users(id),
  name text not null,
  open_join boolean not null default false,   -- true for the demo session
  created_at timestamptz default now()
);

create table invites (
  session_code text not null references sessions(code) on delete cascade,
  email text not null,
  invited_at timestamptz default now(),
  primary key (session_code, email)
);

create table demo_usage (
  key text primary key,      -- sha256 of the request IP
  count int not null default 0,
  first_seen timestamptz default now()
);

alter table profiles enable row level security;
alter table sessions enable row level security;
alter table invites  enable row level security;

create policy own_profile on profiles for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- You see a session if you own it, were invited by email, or it is open_join.
create policy visible_sessions on sessions for select using (
  owner_user_id = auth.uid()
  or open_join
  or exists (select 1 from invites i
             where i.session_code = sessions.code
               and i.email = auth.jwt() ->> 'email')
);
create policy manage_own_sessions on sessions for all
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

create policy owner_manages_invites on invites for all using (
  exists (select 1 from sessions s
          where s.code = invites.session_code and s.owner_user_id = auth.uid())
);
```

**Reading another person's credentials** must not be a plain `select` on `profiles`. Expose it
as a function so the check lives in one place:

```sql
create or replace function credentials_for(session_code text)
returns table (project_url text, anon_key text)
language sql security definer as $$
  select p.project_url, p.anon_key
  from sessions s join profiles p on p.user_id = s.owner_user_id
  where s.code = session_code
    and (s.owner_user_id = auth.uid()
         or s.open_join
         or exists (select 1 from invites i
                    where i.session_code = s.code
                      and i.email = auth.jwt() ->> 'email'));
$$;
```

**Enable anonymous sign-in** in this project's Auth settings — off by default, and demo mode
needs it.

#### Owner project — extend `SCHEMA_SQL` in `src/rag/sync.ts`

```sql
create table if not exists sessions (
  id text primary key,
  name text not null,
  shared boolean not null default false
);

alter table sources   add column if not exists session_id text;
alter table chunks    add column if not exists session_id text;
alter table deletions add column if not exists session_id text;

-- Owner keeps full access; the anon role reaches only shared sessions.
create policy shared_sources on sources for all using (
  user_id = auth.uid()
  or exists (select 1 from sessions s where s.id = sources.session_id and s.shared)
);
-- same shape for chunks and deletions
```

#### Code changes

- **`src/rag/sync.ts`** — stamp `session_id` on every row written, filter reads by the active
  session. `syncNow()` already reconciles whole tables; this is a column, not a redesign.
  Add `resolveSession(code)` calling `credentials_for` on the directory.
- **`extension/src/protocol.ts`** — `listSessions` · `createSession` · `joinSession` ·
  `inviteToSession` · `switchSession`.
- **`extension/src/offscreen/main.ts`** — handlers; sync fires automatically on join/switch.
- **Panel + web app UI** — current session, switcher, **Invite by email**, **Join by code**.
- **A personal session on first sign-in**, so solo use is a session of one and there is no
  second code path.

#### State plainly, in the UI

- Everyone in a session reads every passage in it.
- A join code is a bearer token; **an invite is not**, because credentials are released only
  to an address the owner named. Prefer invites; codes exist for the demo.
- **Known limit:** RLS sees an anon key, not which code was used, so a member of one shared
  session could hand-craft a request reaching *another session the same owner has shared*.
  Private sessions are never exposed. Closing it properly needs per-session minted JWTs — a
  few hours; not worth it before the deadline.

---

### Step 4 — Demo mode and the web app (~3h)

- **Sign-in screen with `Demo mode` underneath.** Anonymous sign-in → join your session code
  → **full management**, as decided. `pnpm demo:seed` rebuilds the corpus when someone empties
  it; assume they will.
- **Ten answers per visitor, not resettable.** Counted in `demo_usage` keyed by
  `sha256(request IP)` inside the Netlify Function. Client counters reset on reload;
  `localStorage` resets on clearing site data. Copy: *"Demo answers are billed to the author —
  ten per visitor so everyone gets a turn. Add your own key for unlimited."*
- **`netlify/functions/ask.ts`** — holds `ANTHROPIC_API_KEY` as an env var, enforces the cap
  and a `max_tokens` ceiling, proxies to `api.anthropic.com`. **A static export has no server,
  so a key in the bundle is extractable and drainable.** The extension keeps using the
  person's own key; the web app is proxied and says so.
- **`externally_connectable`** in `extension/manifest.json` naming the Netlify origin and
  `http://localhost:3111/*`, plus `chrome.runtime.onMessageExternal` in
  `extension/src/background.ts` forwarding the existing `Request` union. Extension installed →
  both surfaces are one signed-in state. Not installed → the app signs in itself and shows the
  download button. **Rebuild the zip after setting the origin.**
- **Keep stays extension-only** and the UI says so: *"Highlighting on any page needs the
  extension. Everything after that is here."*

---

### Step 5 — Submission assets (~2h, do not skip)

**Description**, the four required points:

1. *Why WebMCP fits* — 7 tools on `document.modelContext` of **every page you visit**, so any
   agent working in the browser reaches the memory with no integration, endpoint or key. It
   also *installs* the surface: most pages have none (measured `undefined` on wikipedia.org).
2. *Better UX* — capture costs one gesture where you already are; nothing enters unexamined;
   answers cite the page each claim came from.
3. *People and agents together* — an agent triages the review queue and rules on flagged
   pairs while **approval stays human**; and several people share one session, one memory,
   one agent.
4. *How it was implemented* — `registerTool` via a MAIN-world content script plus
   `@mcp-b/global`; `AbortController` lifetimes because `unregisterTool` was removed;
   `CallToolResult` envelopes because bare objects arrive empty at a bridge. Cite
   `lib/webmcp/API-DELTA.md` — 19 measured findings.

**Video, under 3 minutes:** live URL → download and install the extension → highlight on a
real article → review and approve → ask, get a cited answer → **discard the cited passage
mid-conversation and ask again**, showing it admit the memory no longer holds it → a second
browser joins the session by invite and answers from the same memory.

---

### Step 6 — Rewrite HUMAN-TASKS.md when the build is done

**Do not skip and do not patch it.** `HUMAN-TASKS.md` currently describes a single-player,
single-device product with three tabs and no sessions. Sessions, invites, demo mode and the
web app change what a person actually does, so the test plan has to be rebuilt around the
new shape, not amended at the edges.

The version to write covers, in the order someone would meet them:

1. **Open the live URL and click Demo mode** — search, ask, paste a passage, watch it screen
   and land in review, approve it. No account, no install.
2. **Download and load the extension**, and confirm the web app now shows the same corpus.
3. **Capture** — highlight, image, whole page, PDF reader.
4. **Review** — edit, discard, contradiction flagged with both sides.
5. **Ask** — cited answers, refusal when nothing covers it, Remember for follow-ups.
6. **Sessions** — create one, invite a second address, sign in as that person, confirm they
   see it and their edits reach the owner. Confirm a *private* session stays invisible.
7. **Memory** — sync across two browser profiles, and a forgotten source staying forgotten.

Two things to carry over verbatim, because they are the failures worth catching: **an
answer that asserts something the passages do not support**, and **a deletion that comes
back after a sync**.

Also correct the current file's claim that sections 1–5 were hand-tested — that was true of
the pre-session build and will not be true of this one.

---

### Cut line

Steps 1, 2, 5 and 6 are non-negotiable. If time goes: drop invites to codes-only, then
`externally_connectable`, then demo mode's seed script. Sessions themselves are the feature —
protect them.

Step 6 is on that list deliberately. A test plan describing a product that no longer exists is
worse than none: it sends whoever reads it looking for controls that moved and reassures them
about paths nobody has walked.

### Verification

```bash
pnpm typecheck && pnpm ext && pnpm ext:check   # 48/48
pnpm ext:sync                                   # two profiles, deletions stick
pnpm ext:zip && pnpm build                      # zip packs, app exports cleanly
```

`ext:zip` before `build`, always — `build` copies `public/` into `out/`, so running it first
publishes a site whose download link 404s.

As a judge: open the Netlify URL in Chrome with WebMCP enabled → click **Demo mode** → search,
ask, paste a passage, approve it → download the zip, load unpacked, reload the app → it now
shows the extension's corpus → highlight on a third-party page and watch it arrive.

### Risks

- **The web app is untested by hand.** A tool-name collision with the extension was fixed
  today and never confirmed. Open `localhost:3111`, check the console, *before* deploying.
- **`externally_connectable` needs the real origin at build time** — deploy, set the origin,
  then rebuild the zip, or the downloaded extension cannot talk to the site it came from.
- **Demo mode spends your money.** The cap is IP-based, so a VPN defeats it. Set a spend limit
  on the key.

---

## 7. Repo map

```
extension/
  src/content/    selection.ts (capture bridge) · webmcp.ts (7 tools on every page)
                  keep-ui.ts (the Keep button — shared with the reader)
  src/offscreen/  main.ts (owns the corpus) · answer.ts (Ask) · index.html
  src/sidepanel/  three tabs; the chat lives in Recall
  src/reader/     renders PDFs with pdf.js so a highlight is real DOM (D19)
  src/background.ts  menus, shortcuts, tab routing
  build.mjs · zip.mjs   esbuild bundler · the deploy's extension zip

src/rag/          THE ENGINE — embed · chunk · store · search · screen · sync
src/webmcp/       the web app's tool surface (5 registered at load; the rest by state)
app/ components/  the web app
types/            JSX typings for the declarative attrs · document.modelContext
netlify.toml      build command, publish dir, and why COOP/COEP stay off

probes/           extension-check (48) · sync-check · webmcp-loop · relay-check
bench/            retrieval benchmark          evals/  11 QA pairs

lib/webmcp/API-DELTA.md   19 verified findings. Highest-value doc in the repo.
HUMAN-TASKS.md            what to test by hand, and what is still untested
amendments.md             A13 is current
```

---

## 8. If you change one thing, re-run these

```bash
pnpm typecheck && pnpm ext && pnpm ext:check   # 48/48
pnpm ext:sync                                   # two profiles, deletions stick
pnpm bench                                      # needs pnpm dev running
```

Panel-only changes: `pnpm ext:watch` stamps a build id and the panel tab live-reloads.
Service worker, content script or offscreen changes still need a manual extension reload.
