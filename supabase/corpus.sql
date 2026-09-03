-- The corpus project — where one person's passages actually live.
--
-- Run this in the SQL editor of **your own** Supabase project (the one in .env
-- here), never in the admin/directory project (.env2). Every user of Autorag
-- runs this in a project they own; that is what keeps corpora private by default.
--
-- Idempotent. Every statement is if not exists, drop … if exists, or an
-- alter that is a no-op when already applied, so re-running the whole file over
-- an earlier version is the intended way to pick up a change.
--
-- The panel shows this same script under Settings → Memory, with a Copy button.
-- It is SCHEMA_SQL in src/rag/sync.ts, and pnpm sql:check fails if the two
-- drift apart.
--
-- ## What is safe about shipping the key that reaches this
--
-- Supabase's publishable key is designed to be public: it grants nothing on its
-- own, and the policies below scope every row. The credential that matters is the
-- session JWT, which is per-user and expires.
--
-- ## Why the whole thing is one transaction
--
-- DDL in Postgres is transactional, and this file drops policies before it
-- recreates them. A failure in between -- a typo, a lost connection, a statement
-- the editor refuses -- would otherwise leave the tables with RLS enabled and no
-- policy at all: every read denied, sync silently dark, and the corpus looking
-- lost rather than locked. begin/commit makes it all-or-nothing.

begin;

create extension if not exists vector;

-- ---------------------------------------------------------------- tables ----

create table if not exists sources (
  id text primary key,
  user_id uuid default auth.uid(),
  url text not null, title text not null,
  ingested_at timestamptz not null, stale boolean not null default false,
  stale_reason text, tags text[] not null default '{}'
);

create table if not exists chunks (
  id text primary key,
  user_id uuid default auth.uid(),
  source_id text not null, text text not null, ordinal int not null,
  embedding vector(384), status text not null, conflicts jsonb not null default '[]',
  ingested_at timestamptz not null, decided_at timestamptz,
  rejection_reason text, note text,
  fts tsvector generated always as (to_tsvector('english', text)) stored
);

create table if not exists deletions (
  id text primary key,
  user_id uuid default auth.uid(),
  kind text not null, at timestamptz not null
);

-- vector(384) and the generated tsvector are not read by the mirror — ranking
-- happens in IndexedDB. They cost nothing now and mean server-side ranking could
-- be added later without a migration or a re-index.

-- -------------------------------------------------------------- sessions ----

-- A named corpus that may be shared. shared is the whole access decision, which
-- is why nobody but the owner may write this table.
create table if not exists sessions (
  id text primary key,
  user_id uuid not null default auth.uid(),
  name text not null,
  shared boolean not null default false,
  created_at timestamptz default now()
);

alter table sources   add column if not exists session_id text;
alter table chunks    add column if not exists session_id text;
alter table deletions add column if not exists session_id text;

-- ## Why user_id stops being NOT NULL
--
-- A member of a shared session reaches this project as the **anon** role, holding
-- the owner's publishable key and signed in as nobody — so auth.uid() is null
-- for them, and the column default evaluates to null. With not null in place
-- every write by a member fails, and the error names the column rather than the
-- reason, which is a bad hour waiting to happen.
--
-- So a row is owned either by a person or by a shared session. The constraint
-- below enforces that it is owned by *something*: a row with neither is
-- unreachable by any policy — invisible to the owner, invisible to members, and
-- impossible to delete through the API.
alter table sources   alter column user_id drop not null;
alter table chunks    alter column user_id drop not null;
alter table deletions alter column user_id drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sources_reachable') then
    alter table sources add constraint sources_reachable
      check (user_id is not null or session_id is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chunks_reachable') then
    alter table chunks add constraint chunks_reachable
      check (user_id is not null or session_id is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'deletions_reachable') then
    alter table deletions add constraint deletions_reachable
      check (user_id is not null or session_id is not null);
  end if;
end $$;

-- ------------------------------------------------------------------ RLS ----

alter table sources   enable row level security;
alter table chunks    enable row level security;
alter table deletions enable row level security;
alter table sessions  enable row level security;

-- The single-user policies these replace. Dropped by name so the file can be
-- re-run over a project created before sessions existed.
drop policy if exists own_sources   on sources;
drop policy if exists own_chunks    on chunks;
drop policy if exists own_deletions on deletions;

drop policy if exists shared_sources   on sources;
drop policy if exists shared_chunks    on chunks;
drop policy if exists shared_deletions on deletions;

-- Yours, or in a session you have marked shared. with check repeats using
-- rather than being omitted: for INSERT, Postgres falls back to using when
-- with check is absent, and relying on that makes the write rule invisible to
-- anyone reading the policy.
create policy shared_sources on sources for all
  using (
    user_id = auth.uid()
    or exists (select 1 from sessions s where s.id = sources.session_id and s.shared)
  )
  with check (
    user_id = auth.uid()
    or exists (select 1 from sessions s where s.id = sources.session_id and s.shared)
  );

create policy shared_chunks on chunks for all
  using (
    user_id = auth.uid()
    or exists (select 1 from sessions s where s.id = chunks.session_id and s.shared)
  )
  with check (
    user_id = auth.uid()
    or exists (select 1 from sessions s where s.id = chunks.session_id and s.shared)
  );

create policy shared_deletions on deletions for all
  using (
    user_id = auth.uid()
    or exists (select 1 from sessions s where s.id = deletions.session_id and s.shared)
  )
  with check (
    user_id = auth.uid()
    or exists (select 1 from sessions s where s.id = deletions.session_id and s.shared)
  );

-- ## The two policies on sessions, and why the split matters
--
-- shared is the entire access decision for every row above. If a member could
-- write this table, they could flip shared on a session they were never invited
-- to and then read all of it — a privilege escalation reached with nothing but the
-- key they were legitimately given.
--
-- So: the owner manages sessions, and everyone else may only *read* the rows that
-- are already shared, which is the minimum the policies above need in order to
-- evaluate. An anon caller fails user_id = auth.uid() because auth.uid() is
-- null, so the manage policy cannot admit them for INSERT, UPDATE or DELETE.
drop policy if exists own_sessions on sessions;
create policy own_sessions on sessions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists shared_sessions_readable on sessions;
create policy shared_sessions_readable on sessions for select using (shared);

-- --------------------------------------------------------------- indexes ----

create index if not exists chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_fts_idx on chunks using gin (fts);
-- Every policy above filters on session_id, so it is on the hot path of every
-- read a member makes.
create index if not exists sources_session_idx   on sources (session_id);
create index if not exists chunks_session_idx    on chunks (session_id);
create index if not exists deletions_session_idx on deletions (session_id);

commit;
