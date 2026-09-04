# What to test by hand

Everything before sessions — keep, review, discard, recall, PDF reader, Ask — is
covered by `pnpm ext:check` (48 checks against a real browser). Don't re-walk it.

This file is only the parts a machine cannot judge: whether the new surfaces make
sense to a person, and whether the shared-corpus flows behave when two real
browser profiles use them at once.

**Already machine-checked, so don't spend time on it:** session create/invite/join,
**joining with no Supabase project at all**, private-session isolation, demo-mode
credential release, unreviewed passages never reaching Supabase, the ten-answer cap,
the extension↔site bridge, RLS on both projects, and the corpus migration.
(`pnpm session:check` 21 · `dir:check` 10 · `ask:check` 10 · `schema:check` 7.)

---

## 0. Before you start

1. `pnpm ext` then reload the extension at `brave://extensions` — service worker,
   offscreen and content scripts all changed.
2. Live site: <https://autorag-web.netlify.app/>

---

## 0b. Things only you can do

- [ ] **Put passages in `public-demo`.** It is published and open, but empty — demo
      mode currently loads a corpus with nothing in it. Switch to it in Sessions,
      keep and approve 3-4 passages from real articles, sync.
- [ ] **Move anything private out of `first` and `5566YNMQ`.** Both are
      `shared: true` in your corpus project, and demo mode hands that project's key
      to the public — so anyone clicking Demo mode can read them. Personal
      (`session_id = 'personal'`) is never shared and is the safe place.
- [ ] **Turn off Confirm email in BOTH Supabase projects** (Authentication → Sign
      In / Providers → Email → Confirm email).
      - **Directory** (`qkupjhuroorzijbfqdtv`) — this blocks *creating an account
        at all*: signup tries to mail a confirmation link, the free tier refuses
        after a couple of addresses, and you get `email rate limit exceeded`.
      - **Corpus** (`rylggyqpotiyshvsvtpz`) — this blocks *attaching a project*
        with Create, the same way.
      There is nowhere for a confirmation link to land anyway: it points at a Site
      URL nothing serves.
- [ ] **Set a spend limit** on the Anthropic key. The ten-answer cap is keyed on a
      hash of the request address and a VPN defeats it.

---

## 1. Publish a demo corpus (do this first — nothing else works without it)

Panel → **Settings → Sessions**.

- [ ] Create a session, name it, tick **Open to anyone**. A code appears.
- [ ] Keep and approve 3–4 passages from real articles while that session is
      current. (Header should read the session name, not "personal".)
- [ ] Panel → **Sync now**.

**Watch for:** the header naming the wrong session while you keep. If it says
`personal`, the passages went to your private corpus and the demo will be empty.

---

## 1b. Accounts, guest and demo (new — this is the part to judge)

On the live site in a clean profile:

- [ ] The **login screen** appears. Sign up with an email and a password. It should
      not ask for Supabase anything.
- [ ] Sessions panel appears; `public-demo` is listed; the panel explains that
      *creating* a session needs your own project while joining does not.
- [ ] Sign out → **Use as guest** → keep and approve something → sign out again.
      The login screen should now say how many passages are already in this browser
      and offer to clear them.
- [ ] **Demo mode** → loads `public-demo` without an account.

**Watch for:** being asked for a Supabase URL or key at any point before you choose
to host. That was the bug this release exists to fix.

---

## 2. The live site, in a browser with no extension

Use a fresh profile or a guest window.

- [ ] Page loads, no console errors.
- [ ] **Demo mode** → it signs in, finds your open session, loads the passages.
- [ ] Search returns them. Paste a passage → it screens and lands in review →
      approve it.
- [ ] Ask something → cited answer. Ask 11 times → the 11th refuses with a
      message about the per-visitor limit.
- [ ] **Download the extension** link works and the zip opens.

**Watch for:** an answer asserting something the passages don't support. That is
the one failure worth catching by hand and no check can see it.

---

## 3. Install the extension from the site

- [ ] Unzip, `chrome://extensions` → Developer mode → Load unpacked.
- [ ] Reload the site. The panel should now say **The extension is installed**,
      show a version, and hide the install steps.

---

## 4. Sessions across two profiles

Second browser profile, extension loaded.

- [ ] Profile B: Settings → Memory → same Supabase project, sign in with a
      *different* email.
- [ ] Profile A: Sessions → invite B's email to a **private** session (not the
      open one).
- [ ] Profile B: Sessions → the session appears → switch to it → passages arrive.
- [ ] Profile B keeps something into it, syncs. Profile A syncs and sees it.
- [ ] Profile B: header says **hosted by someone else**, with the warning that
      what they approve is readable by everyone in the session.
- [ ] Switch B back to **personal** → A's passages disappear from B's view;
      B's own private passages are still there.

**Watch for:** a deletion that comes back. Forget a source in A, sync both, then
sync again. If it reappears, tombstones are broken — stop and report it.

---

## 5. Judge's path, end to end

One clean profile, no extension, pretending to know nothing:

Open the URL → Demo mode → search → ask → download → install → reload the site →
highlight something on a third-party article → approve it in the panel → ask about
it.

If that runs without you explaining anything, the submission works.

---

## Known and expected

- One console error on `http://localhost` only: a WebSocket to `127.0.0.1:9333`.
  That's the optional local relay; it is skipped on `https`, so it cannot appear
  on the live site.
- Demo mode is writable on purpose. What a visitor deletes is deleted for the
  next one. Re-seed by keeping more into the open session.

## Not yet tested by anyone

- The IndexedDB v2→v3 migration. Every automated check starts on a fresh profile,
  so your browser is the first real test. If your corpus looks empty after
  reloading the extension, that is the migration — report it, don't work around it.
