/**
 * Does supabase/corpus.sql actually apply, migrate, and protect anything?
 *
 *   pnpm schema:check          # needs docker; skips cleanly without it
 *
 * ## Why this exists
 *
 * Two versions of this schema were handed to a person to paste into their own
 * project, and both failed there: one created policies without dropping them
 * first, and one seeded a row whose `user_id` defaulted to `auth.uid()` — which is
 * null in the SQL editor, because nobody is signed in. Neither could have survived
 * being run once against a real Postgres, and neither was.
 *
 * So this runs it against a real Postgres. `auth.uid()` returns null here on
 * purpose: that is precisely the condition the SQL editor runs under, and it is
 * the one that broke.
 *
 * ## What it asserts, and why as a non-owner
 *
 * The interesting claims are about row-level security, and a table's owner is
 * exempt from it. Checked as `postgres`, every one of these would pass whether the
 * policies worked or not. So the reads below run as an unprivileged role standing
 * in for a session member holding the owner's publishable key.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'autorag-schema-check';
const IMAGE = 'pgvector/pgvector:pg16';

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });

try {
  sh('docker', ['info']);
} catch {
  console.log('SKIP  docker is not available — corpus.sql was not exercised');
  process.exit(0);
}

const psql = (sql, role) =>
  sh('docker', ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-tAq', '-v', 'ON_ERROR_STOP=1'], {
    input: role ? `set role ${role};\n${sql}` : sql,
  }).trim();

let pass = 0;
const failures = [];
const ok = (cond, name, note = '') => {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${note ? ` — ${note}` : ''}`);
  }
};

try {
  sh('docker', ['rm', '-f', NAME]);
} catch {
  /* not running */
}

console.log(`starting ${IMAGE}…`);
sh('docker', ['run', '--rm', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=x', IMAGE]);

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      sh('docker', ['exec', NAME, 'pg_isready', '-q']);
      up = true;
    } catch {
      sh('sleep', ['1']);
    }
  }
  if (!up) throw new Error('postgres never became ready');

  /*
   * Supabase's auth schema, reduced to what the script touches. `auth.uid()`
   * returns null deliberately — that is the SQL editor's condition, and the one
   * that broke the seed row.
   */
  psql(`
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    create table if not exists auth.users (id uuid primary key);
    insert into auth.users (id) values ('11111111-1111-1111-1111-111111111111') on conflict do nothing;
  `);

  const corpus = readFileSync(resolve(root, 'supabase/corpus.sql'), 'utf8');

  // Start from the shape a corpus had before sessions, so the migration is the
  // thing under test rather than a fresh create.
  psql(`
    create extension if not exists vector;
    create table sources (
      id text primary key, user_id uuid default auth.uid(),
      url text not null, title text not null, ingested_at timestamptz not null,
      stale boolean not null default false, stale_reason text, tags text[] not null default '{}');
    create table chunks (
      id text primary key, user_id uuid default auth.uid(),
      source_id text not null, text text not null, ordinal int not null,
      embedding vector(384), status text not null, conflicts jsonb not null default '[]',
      ingested_at timestamptz not null, decided_at timestamptz,
      rejection_reason text, note text,
      fts tsvector generated always as (to_tsvector('english', text)) stored);
    create table deletions (
      id text primary key, user_id uuid default auth.uid(),
      kind text not null, at timestamptz not null);
    insert into sources (id,user_id,url,title,ingested_at)
      values ('src_old','11111111-1111-1111-1111-111111111111','https://e.com/a','A',now());
    insert into chunks (id,user_id,source_id,text,ordinal,status,ingested_at)
      values ('chk_old','11111111-1111-1111-1111-111111111111','src_old','hello',0,'approved',now());
  `);

  psql(corpus);
  ok(true, 'corpus.sql applies to a pre-sessions corpus');

  const stamped = psql(`select session_id from sources where id='src_old';`);
  ok(stamped === 'personal', 'a row kept before sessions is migrated into the personal one', stamped);

  const cols = psql(`
    select string_agg(table_name || ':' || is_nullable, ',' order by table_name)
    from information_schema.columns where column_name='session_id';`);
  ok(
    cols === 'chunks:NO,deletions:NO,sources:NO',
    'session_id is NOT NULL on every table, so the null case cannot come back',
    cols,
  );

  let rejected = false;
  try {
    psql(`insert into sources (id,user_id,url,title,ingested_at,session_id)
          values ('src_null','11111111-1111-1111-1111-111111111111','u','t',now(),null);`);
  } catch {
    rejected = true;
  }
  ok(rejected, 'a row with no session is refused');

  psql(corpus);
  ok(true, 'it is idempotent — a second run commits');

  // --- RLS, as somebody who is not the owner ------------------------------
  psql(`
    create role member nologin;
    grant usage on schema public to member;
    grant select, insert, update, delete on all tables in schema public to member;
    insert into sessions (id,user_id,name,shared) values
      ('team','11111111-1111-1111-1111-111111111111','Team',true),
      ('secret','11111111-1111-1111-1111-111111111111','Secret',false);
    insert into sources (id,user_id,url,title,ingested_at,session_id) values
      ('src_team','11111111-1111-1111-1111-111111111111','u','shared',now(),'team'),
      ('src_secret','11111111-1111-1111-1111-111111111111','u','private',now(),'secret');
  `);

  const seen = psql(`select string_agg(id, ',' order by id) from sources;`, 'member');
  ok(seen === 'src_team', 'a member sees the shared session and nothing else', `saw [${seen}]`);

  psql(`update sessions set shared=true where id='secret';`, 'member');
  const flipped = psql(`select shared from sessions where id='secret';`);
  ok(
    flipped === 'f',
    'a member cannot mark someone else’s private session shared',
    'ESCALATION: shared was flipped',
  );
} finally {
  try {
    sh('docker', ['rm', '-f', NAME]);
  } catch {
    /* already gone */
  }
}

console.log(`\n${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
