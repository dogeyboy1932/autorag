/**
 * Does the one Autorag project's row-level security actually hold, live?
 *
 *   pnpm dir:check          # reads .env (DIRECTORY_URL, DIRECTORY_SECRET_KEY)
 *
 * ## Why this exists as well as `schema:check`
 *
 * `schema:check` proves the SQL is right against a local Postgres. This proves the
 * *deployed* project is running that SQL — that someone pasted the current file,
 * that the policies attached, that PostgREST exposes what the clients call. Every
 * person's passages sit in this project, kept apart by nothing but RLS, so it gets
 * a test that runs against the real thing after every schema edit.
 *
 * ## Why it signs in rather than using the secret key
 *
 * The secret key bypasses RLS. A check written with it goes green whether or not
 * the policies filter anything at all. So every assertion below is made as a real
 * anonymous user holding nothing but the publishable key; the secret key only
 * seeds and cleans up.
 *
 * ## Why it seeds data first
 *
 * An empty table returns `[]` to everyone, which is indistinguishable from RLS
 * working. So user A keeps passages — personal, in a private session, in a shared
 * one — and then user B is asked what they can see. Everything it writes, it
 * deletes, and it counts what it left behind.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '..', process.argv.includes('--env') ? process.argv[process.argv.indexOf('--env') + 1] : '.env');

let env;
try {
  env = Object.fromEntries(
    readFileSync(envFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
  );
} catch {
  console.error(`no ${envFile} — the project's credentials belong there (see .env.example)`);
  process.exit(1);
}

const mod = readFileSync(resolve(here, '..', 'src/rag/directory.ts'), 'utf8');
const committed = (k) => mod.match(new RegExp(`${k}: '([^']*)'`))?.[1] ?? '';

const U = env.DIRECTORY_URL?.replace(/\/$/, '');
// The publishable key is committed by design; `.env` may repeat it but need not.
const PK = env.DIRECTORY_PUBLISHABLE_KEY || committed('publishableKey');
const SK = env.DIRECTORY_SECRET_KEY;
if (!U || !SK) {
  const missing = [!U && 'DIRECTORY_URL', !SK && 'DIRECTORY_SECRET_KEY'].filter(Boolean);
  console.error(`${envFile} is missing ${missing.join(', ')} — see .env.example.`);
  process.exit(1);
}

/*
 * The committed copy has to be the project this check is about to exercise.
 *
 * src/rag/directory.ts carries the URL and publishable key every client uses, and
 * `.env` carries the URL for tooling. If they drift, this suite proves one project
 * is safe while every user talks to another — the most reassuring possible way to
 * be wrong. Compared, never printed.
 */
{
  /*
   * Only quoted values count, not mentions: the doc comment that warns against
   * pasting a secret key writes its prefix too, and a check that rejects a correct
   * file teaches people to ignore it.
   */
  if (/['"`]sb_secret_[A-Za-z0-9_-]{8,}/.test(mod)) {
    console.error('FAIL  src/rag/directory.ts assigns a secret key. It bypasses RLS; remove it.');
    process.exit(1);
  }
  if (committed('url').includes('REPLACE_ME') || committed('publishableKey').includes('REPLACE_ME')) {
    console.error('FAIL  src/rag/directory.ts still has its placeholder URL or key.');
    process.exit(1);
  }
  if (committed('url').replace(/\/$/, '') !== U || committed('publishableKey') !== PK) {
    console.error(
      'FAIL  src/rag/directory.ts does not match .env — every client would talk to a\n' +
        '      different project than this check is about to verify.',
    );
    process.exit(1);
  }
  // A precondition, not a counted assertion.
  console.log('ok    committed project config matches the project under test');
}

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

const json = async (res) => {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
};
const admin = (path, init = {}) =>
  fetch(`${U}${path}`, {
    ...init,
    headers: { apikey: SK, Authorization: `Bearer ${SK}`, 'content-type': 'application/json', ...init.headers },
  }).then(json);
const asUser = (token, path, init = {}) =>
  fetch(`${U}${path}`, {
    ...init,
    headers: { apikey: PK, Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
  }).then(json);
const count = (rows) => (Array.isArray(rows) ? rows.length : `ERR ${JSON.stringify(rows)}`);

const signInAnonymously = () =>
  fetch(`${U}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: PK, 'content-type': 'application/json' },
    body: '{}',
  }).then(json);

const A = await signInAnonymously();
const B = await signInAnonymously();
if (!A?.access_token || !B?.access_token) {
  console.error(
    'could not create an anonymous user. Enable anonymous sign-ins under ' +
      `Authentication → Sign In / Providers. Provider said: ${A?.msg ?? B?.msg ?? JSON.stringify(A)}`,
  );
  process.exit(1);
}
const idA = A.user.id;
const idB = B.user.id;
ok(A.user.is_anonymous === true, 'anonymous sign-in is enabled');

const source = (id, session_id) => ({
  id,
  session_id,
  url: `https://probe.example.com/${id}`,
  title: `probe ${id}`,
  ingested_at: new Date().toISOString(),
});

try {
  // Sessions are seeded as their owner would create them: with A's own token.
  const made = await asUser(A.access_token, '/rest/v1/sessions', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([
      { code: 'PROBEPRIV', owner_user_id: idA, name: 'private probe', open_join: false, shared: false },
      { code: 'PROBESHAR', owner_user_id: idA, name: 'shared probe', open_join: false, shared: true },
      { code: 'PROBEOPEN', owner_user_id: idA, name: 'open probe', open_join: true, shared: false },
    ]),
  });
  ok(count(made) === 3, 'an account can create its own sessions', JSON.stringify(made));

  const kept = await asUser(A.access_token, '/rest/v1/sources', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([
      source('src_probe_personal', 'personal'),
      source('src_probe_priv', 'PROBEPRIV'),
      source('src_probe_shar', 'PROBESHAR'),
    ]),
  });
  ok(count(kept) === 3, 'an account can keep passages, personal and in its sessions', JSON.stringify(kept));
  ok(Array.isArray(kept) && kept.every((r) => r.user_id === idA), 'a passage is stamped with whoever kept it');

  // 42P17: mutually recursive policies. A hard 500 on every read of the table.
  for (const t of ['sessions', 'invites', 'sources', 'chunks', 'deletions']) {
    const r = await asUser(B.access_token, `/rest/v1/${t}?select=*&limit=1`);
    ok(Array.isArray(r), `${t} reads without error`, JSON.stringify(r));
  }

  const bPersonal = await asUser(B.access_token, '/rest/v1/sources?select=id&id=eq.src_probe_personal');
  ok(count(bPersonal) === 0, "nobody else can read a person's personal passages", `saw ${count(bPersonal)}`);

  const bPriv = await asUser(B.access_token, '/rest/v1/sources?select=id&session_id=eq.PROBEPRIV');
  ok(count(bPriv) === 0, "an uninvited person cannot read a private session's passages", `saw ${count(bPriv)}`);

  const bShar = await asUser(B.access_token, '/rest/v1/sources?select=id&session_id=eq.PROBESHAR');
  ok(count(bShar) === 1, 'a shared session is readable by anyone holding its code', `saw ${count(bShar)}`);

  const listed = await asUser(B.access_token, '/rest/v1/sessions?select=code&open_join=is.true&code=like.PROBE*');
  ok(
    Array.isArray(listed) && listed.map((r) => r.code).join() === 'PROBEOPEN',
    'only the open session is listed to a stranger',
    JSON.stringify(listed),
  );

  const intoOpen = await asUser(B.access_token, '/rest/v1/sources', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(source('src_probe_b_open', 'PROBEOPEN')),
  });
  ok(count(intoOpen) === 1, 'anyone can keep into an open session', JSON.stringify(intoOpen));

  const intoPriv = await asUser(B.access_token, '/rest/v1/sources', {
    method: 'POST',
    body: JSON.stringify(source('src_probe_b_priv', 'PROBEPRIV')),
  });
  ok(intoPriv?.code === '42501', 'an uninvited person cannot keep into a private session', JSON.stringify(intoPriv));

  const forgedSession = await asUser(B.access_token, '/rest/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({ code: 'PROBEEVIL', owner_user_id: idA, name: 'forged' }),
  });
  ok(forgedSession?.code === '42501', 'nobody can create a session owned by someone else', JSON.stringify(forgedSession));

  await asUser(B.access_token, '/rest/v1/sessions?code=eq.PROBEPRIV', {
    method: 'PATCH',
    body: JSON.stringify({ shared: true, open_join: true }),
  });
  const flags = await admin('/rest/v1/sessions?select=shared,open_join&code=eq.PROBEPRIV');
  ok(
    Array.isArray(flags) && flags[0] && !flags[0].shared && !flags[0].open_join,
    'a non-owner cannot open up a private session',
    `ESCALATION: ${JSON.stringify(flags)}`,
  );

  const capped = await asUser(B.access_token, '/rest/v1/demo_usage', {
    method: 'POST',
    body: JSON.stringify({ key: 'probe-must-fail', count: 0 }),
  });
  ok(capped?.code === '42501', 'the demo cap cannot be written by the people it caps', JSON.stringify(capped));
} finally {
  // Runs even when an assertion throws, so a failed run does not leave rows that
  // make the next one lie. Deleting the users cascades to anything they kept.
  await admin('/rest/v1/sources?id=like.src_probe_*', { method: 'DELETE' });
  await admin('/rest/v1/sessions?code=in.(PROBEPRIV,PROBESHAR,PROBEOPEN,PROBEEVIL)', { method: 'DELETE' });
  await admin('/rest/v1/demo_usage?key=eq.probe-must-fail', { method: 'DELETE' });
  for (const id of [idA, idB]) {
    await fetch(`${U}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: SK, Authorization: `Bearer ${SK}` },
    });
  }
}

const leftSessions = await admin('/rest/v1/sessions?select=code&code=like.PROBE*');
const leftSources = await admin('/rest/v1/sources?select=id&id=like.src_probe_*');
const left =
  (Array.isArray(leftSessions) ? leftSessions.length : 0) + (Array.isArray(leftSources) ? leftSources.length : 0);
console.log(`\ncleanup: ${left} probe row(s) left behind (0 expected)`);
console.log(`${pass} passed, ${failures.length} failed`);
process.exit(failures.length || left ? 1 : 0);
