# Handoff — minimal context

**Autorag** is a curated retrieval memory in the browser. You keep passages while
reading, approve what stays, and ask questions answered only from what survived,
with citations. Two surfaces: a **web app** (Next.js static export, deployed to
<https://autorag-web.netlify.app>) and a **browser extension** (`extension/`).
One engine in `src/rag/`, used by both.

```bash
pnpm install && pnpm ext        # build the extension
# brave://extensions → Developer mode → Load unpacked → extension/dist
```

Reload the extension after any `pnpm ext`. The web app autodeploys from `main`.

---

## The rules that govern the current work

Stated by the author, and non-negotiable. Most bugs in this area have come from
violating one of them:

1. **One profile schema. No user types.** There is no "host" and no "joiner" — no
   term for a person that changes what they may do. If a session is not in your
   list, you are in someone else's; you have **exactly the same privileges** as
   whoever made it. Like editing a shared Google Doc.
2. **A session is what you see.** In a session you see that session's corpus and
   nothing else. Personal session means your local corpus. 100% of the time.
3. **Anyone in a session has full control of it.** Add, edit, delete. No gating.
4. **Sync is total and immediate.** Whatever is in the local library must land in
   the session's rows on Supabase — on join, on change, and always on the Sync
   button. No late renders.

---

## Two Supabase projects

| | env file | holds |
|---|---|---|
| **Corpus** | `.env` (`SUPABASE_*`) | one person's `sources`, `chunks`, `deletions`, `sessions` |
| **Directory** | `.env2` (`DIRECTORY_*`) | `profiles`, `sessions`, `invites`, `demo_usage`. **Never any passage.** |

Names never overlap: `SUPABASE_*` is always the corpus, `DIRECTORY_*` always the
directory, and no code accepts the other spelling. Schemas are `supabase/corpus.sql`
and `supabase/directory.sql`, both idempotent — re-run the whole file to apply a
change. `SCHEMA_SQL` in `src/rag/sync.ts` must match `corpus.sql`; `pnpm sql:check`
fails if they drift, and rejects backticks in the SQL because it is embedded in a
template literal.

An account is **an email and a password** against the directory. A Supabase project
is optional and only needed to *host* a corpus — never to sign in, never to join.
The two passwords are separate. Sign-up lives only in the web app; the extension
mirrors the account and adds capture.

A shared session needs **two rows**: one in the corpus project (`sessions.shared`,
which is what RLS actually consults) and one in the directory (the code). The corpus
row is written first — the other order left joinable codes authorising nothing.

---

## State as of 2026-09-04

`main`, pushed. Two files dirty: `components/WebSessions.tsx`,
`extension/src/sidepanel/main.tsx`.

Recent commits are the author's: `Clear stale host state on owned sessions`,
`Show only owned sessions`, `Renew expired web Supabase sessions`.
`src/rag/store.ts` now has `setActiveSession` / `getActiveSession` and scopes local
reads to the active session — rule 2 above, partly implemented.

**Live data:** one session, `DXUP6FCL` (`public-demo`, shared, open_join), 2
approved chunks, present in both projects.

---

## Checks

```bash
pnpm typecheck && pnpm sql:check
pnpm ext && pnpm ext:check      # 48 checks, real browser
pnpm dir:check                  # directory RLS, as a real anonymous user
pnpm schema:check               # corpus.sql against a throwaway Postgres (docker)
pnpm session:check              # two profiles, live projects
pnpm ask:check                  # the demo endpoint, one real API call
```

`ext:check` and `dir:check` are the ones that catch real regressions. Both are
written to fail loudly rather than pass vacuously — this repo has shipped several
checks that were green while measuring nothing.

---

## How the author wants this worked on

- **Diagnose, then fix. They do the testing.** Do not write probes to reproduce a
  bug they have already reproduced.
- Be brief. Long explanations and repeated verification runs have wasted whole
  sessions here.
- Ask before large refactors; otherwise just fix the thing.

`HUMAN-TASKS.md` holds what still needs doing by hand, including anything only the
author can do (Supabase settings, seeding `public-demo`).
