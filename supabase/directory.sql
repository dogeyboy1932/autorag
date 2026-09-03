-- The directory project. Run this ONCE, in the SQL editor of the project that is
-- NOT your corpus. Idempotent — safe to re-run after an edit.
--
-- ## What this project is, and what it is emphatically not
--
-- A phone book. It records who someone is, which Supabase project holds *their*
-- corpus, which sessions exist, who was invited to them, and how many demo
-- answers an address has spent.
--
-- **No passage, chunk, embedding or source ever lands here.** Corpora stay in
-- their owners' own projects. That is the whole reason a person can be handed a
-- session without being handed a database.
--
-- ## Why this is a second project rather than two more tables in the first
--
-- A join code hands someone a project's publishable key. If `profiles` lived in
-- the corpus project, that key would also address the table holding *other
-- people's* Supabase credentials, and the only thing in between would be the RLS
-- policies below — which the handoff already admits are imperfect for shared
-- sessions, because RLS sees an anon key and not which code was used to get it.
--
-- Two projects makes that class of mistake unreachable: the key you hand out
-- cannot name the credential table at all.
--
-- ## Before this works
--
-- Enable **anonymous sign-in** in Authentication → Sign In / Providers. It is off
-- by default and demo mode cannot work without it.

-- ---------------------------------------------------------------- tables ----

-- Someone who uses Autorag, and where their own corpus lives. `project_url` and
-- `anon_key` point at a project this one does not own and cannot read — they are
-- a forwarding address, handed out only through credentials_for() below.
create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  project_url text,
  anon_key text,
  created_at timestamptz default now()
);

-- A corpus several people share. `code` is short and shareable; `open_join` is
-- true only for the demo session, and is what lets a stranger in without an
-- invite.
create table if not exists sessions (
  code text primary key,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  open_join boolean not null default false,
  created_at timestamptz default now()
);

-- An invitation by email address. Deliberately keyed by address rather than by
-- user id: you invite people who have not signed up yet.
create table if not exists invites (
  session_code text not null references sessions(code) on delete cascade,
  email text not null,
  invited_at timestamptz default now(),
  primary key (session_code, email)
);

-- The demo cap. `key` is a sha256 of the requesting IP — the address itself is
-- never stored, and a hash is enough to count against.
create table if not exists demo_usage (
  key text primary key,
  count int not null default 0,
  first_seen timestamptz default now()
);

-- ------------------------------------------------------------------ RLS ----

alter table profiles   enable row level security;
alter table sessions   enable row level security;
alter table invites    enable row level security;
alter table demo_usage enable row level security;

-- `demo_usage` gets RLS with **no policy at all**, and that is the point rather
-- than an omission.
--
-- Only the Netlify Function touches this table, and it holds the secret key,
-- which bypasses RLS. Every other caller — including any visitor holding the
-- publishable key — matches no policy and therefore sees and writes nothing.
--
-- Leaving RLS off would have left the counter world-writable, and the product
-- promise is specifically "ten per visitor, **not resettable**". A cap anyone can
-- zero from the console is not a cap.

drop policy if exists own_profile on profiles;
create policy own_profile on profiles for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- You can see a session if you own it, were invited by email, or it is open.
drop policy if exists visible_sessions on sessions;
create policy visible_sessions on sessions for select using (
  owner_user_id = auth.uid()
  or open_join
  or exists (select 1 from invites i
             where i.session_code = sessions.code
               and i.email = auth.jwt() ->> 'email')
);

drop policy if exists manage_own_sessions on sessions;
create policy manage_own_sessions on sessions for all
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

drop policy if exists owner_manages_invites on invites;
create policy owner_manages_invites on invites for all using (
  exists (select 1 from sessions s
          where s.code = invites.session_code and s.owner_user_id = auth.uid())
);

-- ------------------------------------------------------------- lookup ------

-- Reading another person's credentials must never be a plain `select` on
-- `profiles`, or the check that decides who may have them would live at every
-- call site instead of one.
--
-- `security definer` means this runs as its owner and can read rows the caller
-- cannot — so the WHERE clause is the entire access control for the most
-- sensitive thing this project stores. Read it as such before changing it.
create or replace function credentials_for(session_code text)
returns table (project_url text, anon_key text)
language sql
security definer
-- Pinned so a caller cannot put a schema of their own in front of `sessions` or
-- `profiles` and have a definer-rights function resolve to it.
set search_path = public, pg_temp
as $$
  select p.project_url, p.anon_key
  from sessions s join profiles p on p.user_id = s.owner_user_id
  where s.code = session_code
    and (s.owner_user_id = auth.uid()
         or s.open_join
         or exists (select 1 from invites i
                    where i.session_code = s.code
                      and i.email = auth.jwt() ->> 'email'));
$$;

-- The function is the only supported way in, so revoke the blanket EXECUTE that
-- `create function` hands to PUBLIC and grant it back deliberately.
revoke all on function credentials_for(text) from public;
grant execute on function credentials_for(text) to anon, authenticated;
