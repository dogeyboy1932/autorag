/**
 * Does supabase/autorag.sql actually apply, migrate, and keep people apart?
 *
 *   pnpm schema:check          # needs docker; skips cleanly without it
 *
 * ## Why this exists
 *
 * Schemas here have been handed to a person to paste into a project, and two of
 * them failed there on first contact — policies created without being dropped
 * first, a seed row whose `user_id` defaulted to a null `auth.uid()`. Neither could
 * have survived one run against a real Postgres, and neither had had one.
 *
 * So this runs the real file against a real Postgres, starting from the shape the
 * live project actually had — the old directory schema, `credentials_for` and all —
 * and applies it twice, because re-running it is the documented way to update.
 *
 * ## Why as a non-owner, and why several of them
 *
 * A table's owner is exempt from RLS, so checked as `postgres` every assertion
 * would pass whether the policies worked or not. Everything below runs as the
 * `authenticated` role with a different user id and email in the JWT claims —
 * which is what PostgREST does with a real token — because the whole claim of one
 * shared project is that the people in it cannot see each other.
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
  console.log('SKIP  docker is not available — autorag.sql was not exercised');
  process.exit(0);
}

const psql = (sql) =>
  sh('docker', ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-tAq', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
  }).trim();

const USERS = {
  ann: { id: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'ann@example.com' },
  bob: { id: 'bbbbbbbb-0000-0000-0000-000000000002', email: 'bob@example.com' },
  cat: { id: 'cccccccc-0000-0000-0000-000000000003', email: 'cat@example.com' },
};

/** Runs as a signed-in user, the way PostgREST would with their JWT. */
const as = (who, sql) =>
  psql(
    `set role authenticated;
     set "request.jwt.claim.sub" = '${USERS[who].id}';
     set "request.jwt.claim.email" = '${USERS[who].email}';
     ${sql}`,
  );

/** Like `as`, but reports whether Postgres refused the statement. */
const refused = (who, sql) => {
  try {
    as(who, sql);
    return false;
  } catch {
    return true;
  }
};

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
  /*
   * Ready means a query answers, not that pg_isready does: the image's init script
   * starts the server, stops it and starts it again, and pg_isready can catch the
   * first one just before it goes away.
   */
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      psql('select 1;');
      up = true;
    } catch {
      sh('sleep', ['1']);
    }
  }
  if (!up) throw new Error('postgres never became ready');

  /*
   * Supabase's auth schema and roles, reduced to what the script touches.
   * `auth.uid()` and `auth.jwt()` read the request claims, as Supabase's do; in
   * the SQL editor nobody is signed in and both come back null.
   */
  psql(`
    create role anon nologin;
    create role authenticated nologin;
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    create schema if not exists auth;
    grant usage on schema auth to anon, authenticated;
    create or replace function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create or replace function auth.jwt() returns jsonb language sql stable as
      $$ select jsonb_build_object('email', current_setting('request.jwt.claim.email', true)) $$;
    create table if not exists auth.users (id uuid primary key);
    insert into auth.users (id) values
      ('${USERS.ann.id}'), ('${USERS.bob.id}'), ('${USERS.cat.id}');
  `);

  // The live project's starting point: the old directory schema, from git.
  const before = sh('git', ['show', 'ab357fc:supabase/directory.sql'], { cwd: root });
  psql(before);
  psql(`
    insert into profiles (user_id, email, project_url, anon_key)
      values ('${USERS.ann.id}', '${USERS.ann.email}', 'https://old.supabase.co', 'sb_publishable_x');
    insert into sessions (code, owner_user_id, name, open_join)
      values ('OLDSESSN', '${USERS.ann.id}', 'kept from before', false);
  `);

  const schema = readFileSync(resolve(root, 'supabase/autorag.sql'), 'utf8');
  psql(schema);
  ok(true, 'autorag.sql applies over the old directory schema');
  psql(schema);
  ok(true, 'autorag.sql re-applies cleanly — re-running it is the update path');

  ok(
    psql(`select count(*) from sessions where code = 'OLDSESSN';`) === '1',
    'existing sessions survive the migration',
  );
  ok(
    psql(
      `select count(*) from information_schema.columns where table_name = 'profiles' and column_name in ('project_url','anon_key');`,
    ) === '0',
    'profiles no longer stores anyone’s project credentials',
  );
  ok(psql(`select count(*) from pg_proc where proname = 'credentials_for';`) === '0', 'credentials_for is gone');

  // ------------------------------------------------------------ personal rows
  as('ann', `insert into sources (id, url, title, ingested_at) values ('src_ann', 'https://a.com', 'Ann private', now());`);
  ok(as('ann', `select count(*) from sources where id = 'src_ann';`) === '1', 'a person reads their own personal rows');
  ok(
    as('bob', `select count(*) from sources where id = 'src_ann';`) === '0',
    'nobody else can read a personal row',
    'LEAK: bob read ann’s personal passage',
  );
  ok(
    refused(
      'bob',
      `insert into sources (id, user_id, url, title, ingested_at) values ('src_forged', '${USERS.ann.id}', 'https://b.com', 'forged', now());`,
    ),
    'a personal row cannot be written in someone else’s name',
  );
  as('bob', `update sources set title = 'hijacked' where id = 'src_ann';`);
  ok(psql(`select title from sources where id = 'src_ann';`) === 'Ann private', 'nobody else can edit a personal row');

  // ------------------------------------------------- private session + invite
  as('ann', `insert into sessions (code, owner_user_id, name, shared) values ('PRIVATE1', '${USERS.ann.id}', 'private', false);`);
  as(
    'ann',
    `insert into sources (id, session_id, url, title, ingested_at) values ('src_p1', 'PRIVATE1', 'https://p.com', 'in private', now());`,
  );
  ok(as('bob', `select count(*) from sessions where code = 'PRIVATE1';`) === '0', 'an uninvited person cannot see a private session');
  ok(
    as('bob', `select count(*) from sources where session_id = 'PRIVATE1';`) === '0',
    'an uninvited person cannot read a private session’s passages',
    'LEAK',
  );
  ok(
    refused(
      'bob',
      `insert into sources (id, session_id, url, title, ingested_at) values ('src_bob_p1', 'PRIVATE1', 'https://x.com', 'x', now());`,
    ),
    'an uninvited person cannot write into a private session',
  );
  as('ann', `insert into invites (session_code, email) values ('PRIVATE1', '${USERS.bob.email}');`);
  ok(as('bob', `select count(*) from sources where session_id = 'PRIVATE1';`) === '1', 'an invited person reads the session');
  as('bob', `update sources set stale = true where id = 'src_p1';`);
  ok(
    psql(`select stale from sources where id = 'src_p1';`) === 't',
    'an invited person can act on a passage someone else kept there',
  );
  ok(as('cat', `select count(*) from sources where session_id = 'PRIVATE1';`) === '0', 'an invite admits only the address it names');

  // ------------------------------------------------ shared and open sessions
  as('ann', `insert into sessions (code, owner_user_id, name, shared) values ('SHARED22', '${USERS.ann.id}', 'by code', true);`);
  as('ann', `insert into sessions (code, owner_user_id, name, open_join) values ('OPEN3333', '${USERS.ann.id}', 'public-demo', true);`);
  ok(
    as('cat', `select count(*) from sessions where code = 'SHARED22';`) === '1' &&
      !refused(
        'cat',
        `insert into sources (id, session_id, url, title, ingested_at) values ('src_cat', 'SHARED22', 'https://c.com', 'c', now());`,
      ),
    'a shared session is usable by anyone holding its code',
  );
  ok(
    as('cat', `select string_agg(code, ',' order by code) from sessions where open_join;`) === 'OPEN3333',
    'only open sessions are listed to a stranger',
  );

  // ---------------------------------------------------------- escalation
  as('bob', `update sessions set shared = true, open_join = true where code = 'PRIVATE1';`);
  ok(
    psql(`select shared or open_join from sessions where code = 'PRIVATE1';`) === 'f',
    'a member cannot open up a session they do not own',
    'ESCALATION: flags were flipped',
  );
  ok(
    refused('bob', `insert into invites (session_code, email) values ('PRIVATE1', 'friend@example.com');`),
    'only the owner can invite',
  );

  // ---------------------------------------------------------- demo counter
  psql(`insert into demo_usage (key, count) values ('k', 3);`);
  ok(
    as('cat', `select count(*) from demo_usage;`) === '0' &&
      refused('cat', `insert into demo_usage (key, count) values ('mine', 0);`),
    'the demo counter is invisible and unwritable to everyone but the server',
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
