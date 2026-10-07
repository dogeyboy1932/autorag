-- Autorag's one Supabase project: accounts, sessions, and everyone's passages.
--
-- This is the admin project — DIRECTORY_URL in `.env`, the one whose URL and
-- publishable key are compiled into every client. Run this file in its SQL editor.
--
-- Idempotent: every statement is `if not exists`, `drop … if exists`, `create or
-- replace` or an alter that is a no-op once applied, so re-running the whole file
-- over an earlier version is the intended way to pick up a change. One
-- transaction, so a failure part-way cannot leave a table with RLS on and its
-- policy dropped — every read denied, and the corpus looking lost rather than
-- locked.
--
-- ## Why one project now, when there used to be two
--
-- There was a directory project (accounts, sessions, invites), and every person's
-- corpus lived in a project of their own. A session was shared by handing members
-- the owner's publishable key, which made members the `anon` role in somebody
-- else's database — signed in as nobody, so RLS could not tell one member from
-- another, and the directory had to keep everyone's project credentials in a
-- table and guard them with a security-definer lookup.
--
-- One project removes all of that. Everybody — real accounts, anonymous guests,
-- the demo — arrives with a JWT of their own, so every row is decided by who is
-- asking rather than by which key they were handed. There are no credentials to
-- store and no lookup to guard. The cost is that the author hosts everyone's
-- passages, and the policies below are what keep them apart.
--
-- ## Before this works
--
-- Anonymous sign-ins must be on (Authentication → Sign In / Providers → Anonymous
-- sign-ins — its own toggle, separate from Email). Guests and the demo use them.

begin;

create extension if not exists vector;

-- ------------------------------------------------------------ accounts ----

-- Who someone is. The `project_url` and `anon_key` columns that pointed at a
-- person's own corpus project went with those projects.
create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  created_at timestamptz default now()
);
alter table profiles drop column if exists project_url;
alter table profiles drop column if exists anon_key;

-- ------------------------------------------------------------ sessions ----

-- A corpus several people use. `code` is short, and it is also the `session_id`
-- every row in the session carries.
--
--   shared     anyone holding the code may read and write it — the code is the
--              capability, which is why it is random and never listed
--   open_join  it is *listed*, so a stranger can find it without the code
--
-- `personal` has no row here: solo use is reached through `user_id` alone.
create table if not exists sessions (
  code text primary key,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  open_join boolean not null default false,
  created_at timestamptz default now()
);
alter table sessions add column if not exists shared boolean not null default false;

-- Keyed by address rather than user id: you invite people who have not signed up.
create table if not exists invites (
  session_code text not null references sessions(code) on delete cascade,
  email text not null,
  invited_at timestamptz default now(),
  primary key (session_code, email)
);

-- The demo cap. `key` is a sha256 of the requesting IP; the address is never stored.
create table if not exists demo_usage (
  key text primary key,
  count int not null default 0,
  first_seen timestamptz default now()
);

-- -------------------------------------------------------------- corpus ----

-- `user_id` is who wrote the row; in a shared session, who may *read* it is the
-- session's decision. It is never null: guests sign in anonymously and get an id
-- of their own, so there is no nameless writer any more.

create table if not exists sources (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  session_id text not null default 'personal',
  url text not null, title text not null,
  ingested_at timestamptz not null, stale boolean not null default false,
  stale_reason text, tags text[] not null default '{}'
);

create table if not exists chunks (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  session_id text not null default 'personal',
  source_id text not null, text text not null, ordinal int not null,
  embedding vector(384), status text not null, conflicts jsonb not null default '[]',
  ingested_at timestamptz not null, decided_at timestamptz,
  rejection_reason text, note text,
  fts tsvector generated always as (to_tsvector('english', text)) stored
);

create table if not exists deletions (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  session_id text not null default 'personal',
  kind text not null, at timestamptz not null
);

-- ------------------------------------------------------------- helpers ----

-- ## Why these are functions and not subqueries in the policies
--
-- An `exists (select …)` against the other table deadlocks the planner:
-- sessions → invites → sessions → … is `ERROR 42P17: infinite recursion detected
-- in policy`, and every read of either table 500s. A `security definer` function
-- runs as its owner, who is not subject to the table's RLS, so the cycle has
-- nowhere to close. Each answers one question about **the caller** only, so the
-- extra privilege leaks nothing the caller could not already ask.
--
-- Parameters are `p_code`, not `code`: a parameter named for the column it is
-- compared with shadows it, and `where s.code = code` is a tautology that matches
-- every row — an access check that fails open.

create or replace function owns_session(p_code text)
returns boolean language sql security definer stable
set search_path = public, pg_temp as $$
  select exists (
    select 1 from sessions s
    where s.code = p_code and s.owner_user_id = auth.uid()
  );
$$;

create or replace function invited_to_session(p_code text)
returns boolean language sql security definer stable
set search_path = public, pg_temp as $$
  select exists (
    select 1 from invites i
    where i.session_code = p_code and i.email = auth.jwt() ->> 'email'
  );
$$;

-- May the caller read and write this session's rows? The one question every
-- corpus policy below asks.
create or replace function can_use_session(p_code text)
returns boolean language sql security definer stable
set search_path = public, pg_temp as $$
  select exists (
    select 1 from sessions s
    where s.code = p_code
      and (
        s.owner_user_id = auth.uid()
        or s.shared
        or s.open_join
        or exists (
          select 1 from invites i
          where i.session_code = s.code and i.email = auth.jwt() ->> 'email'
        )
      )
  );
$$;

-- Session-to-credentials lookups belonged to the two-project design.
drop function if exists credentials_for(text);

-- ------------------------------------------------------------------ RLS ----

alter table profiles   enable row level security;
alter table sessions   enable row level security;
alter table invites    enable row level security;
alter table demo_usage enable row level security;
alter table sources    enable row level security;
alter table chunks     enable row level security;
alter table deletions  enable row level security;

-- `demo_usage` has RLS and **no policy**, on purpose: only the Netlify Function
-- touches it, with the secret key, which bypasses RLS. Everyone else sees and
-- writes nothing, so the "ten per visitor" cap cannot be zeroed from a console.

drop policy if exists own_profile on profiles;
create policy own_profile on profiles for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- You can see a session you own, were invited to, or that is open or shared.
-- Seeing a shared one is what lets a code be redeemed; only `open_join` sessions
-- are ever *listed*, so it is the code that finds a shared one.
drop policy if exists visible_sessions on sessions;
create policy visible_sessions on sessions for select using (
  owner_user_id = auth.uid() or open_join or shared or invited_to_session(code)
);

-- Only the owner writes `sessions`. `shared` and `open_join` are the whole access
-- decision for every corpus row, so a member who could flip them could open any
-- session whose code they had ever seen.
drop policy if exists manage_own_sessions on sessions;
create policy manage_own_sessions on sessions for all
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

drop policy if exists owner_manages_invites on invites;
create policy owner_manages_invites on invites for all
  using (owns_session(session_code)) with check (owns_session(session_code));

-- The invitee has to see the invite that names them, or `visible_sessions` would
-- consult a row they cannot read.
drop policy if exists own_invites_visible on invites;
create policy own_invites_visible on invites for select
  using (email = auth.jwt() ->> 'email');

-- The corpus. A personal row is its author's alone; a session row belongs to the
-- session. `with check` repeats `using`, so a member can approve or edit a passage
-- someone else kept, and so the write rule is written here rather than implied by
-- Postgres falling back to `using`.
drop policy if exists corpus_sources on sources;
create policy corpus_sources on sources for all
  using (
    (session_id = 'personal' and user_id = auth.uid())
    or (session_id <> 'personal' and can_use_session(session_id))
  )
  with check (
    (session_id = 'personal' and user_id = auth.uid())
    or (session_id <> 'personal' and can_use_session(session_id))
  );

drop policy if exists corpus_chunks on chunks;
create policy corpus_chunks on chunks for all
  using (
    (session_id = 'personal' and user_id = auth.uid())
    or (session_id <> 'personal' and can_use_session(session_id))
  )
  with check (
    (session_id = 'personal' and user_id = auth.uid())
    or (session_id <> 'personal' and can_use_session(session_id))
  );

drop policy if exists corpus_deletions on deletions;
create policy corpus_deletions on deletions for all
  using (
    (session_id = 'personal' and user_id = auth.uid())
    or (session_id <> 'personal' and can_use_session(session_id))
  )
  with check (
    (session_id = 'personal' and user_id = auth.uid())
    or (session_id <> 'personal' and can_use_session(session_id))
  );

-- --------------------------------------------------------------- indexes ----

create index if not exists chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_fts_idx on chunks using gin (fts);
-- Every policy filters on (session_id, user_id), so they sit on every read's path.
create index if not exists sources_owner_idx   on sources (session_id, user_id);
create index if not exists chunks_owner_idx    on chunks (session_id, user_id);
create index if not exists deletions_owner_idx on deletions (session_id, user_id);

commit;
