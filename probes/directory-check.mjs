/**
 * Does the directory project's row-level security actually hold?
 *
 *   pnpm dir:check          # reads .env2 (the admin/directory project)
 *
 * ## Why this exists as a check and not a one-off curl
 *
 * The directory is the only place in Autorag where one person's credentials sit
 * within reach of another person's request. `credentials_for` is `security
 * definer` — it reads rows its caller cannot — so its WHERE clause is the entire
 * access control for the most sensitive thing the system stores. That deserves a
 * test that runs again after every schema edit, not a check someone did once.
 *
 * ## Why it signs in rather than using the secret key
 *
 * The secret key bypasses RLS. A check written with it goes green whether or not
 * the policies filter anything at all — and this schema has already shipped one
 * bug (mutually recursive policies, 42P17) that an admin-only read could not see.
 * So every assertion below is made as a real signed-in user holding nothing but
 * the publishable key.
 *
 * ## Why it seeds data first
 *
 * An empty table returns `[]` to everyone, which is indistinguishable from RLS
 * working. So it creates two sessions owned by user A — one private, one open —
 * and then asks user B what they can see. B seeing exactly one of the two is the
 * assertion; `[]` would prove nothing. Everything it writes, it deletes.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '..', process.argv.includes('--env') ? process.argv[process.argv.indexOf('--env') + 1] : '.env2');

let env;
try {
  env = Object.fromEntries(
    readFileSync(envFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
  );
} catch {
  console.error(`no ${envFile} — the directory project's credentials belong there (see .env.example)`);
  process.exit(1);
}

/*
 * Either spelling. The Netlify Function needs these named DIRECTORY_* so the two
 * Supabase projects cannot be confused on a deploy, and .env2 was renamed to
 * match — which silently broke every probe that read SUPABASE_*. Accepting both
 * costs one `??` and means a naming decision in one place cannot take the checks
 * down in another.
 */
/*
 * DIRECTORY_*, and deliberately without SUPABASE_* as a fallback.
 *
 * There are two Supabase projects in this repo and the generic name does not say
 * which. Accepting both spellings makes that ambiguity permanent and lets a check
 * pass while pointed at the wrong database — the exact failure this naming exists
 * to prevent. One name per thing: SUPABASE_* is the corpus project in .env,
 * DIRECTORY_* is the directory in .env2.
 */
const U = env.DIRECTORY_URL?.replace(/\/$/, '');
const PK = env.DIRECTORY_PUBLISHABLE_KEY;
const SK = env.DIRECTORY_SECRET_KEY;
if (!U || !PK || !SK) {
  const missing = [
    !U && 'DIRECTORY_URL',
    !PK && 'DIRECTORY_PUBLISHABLE_KEY',
    !SK && 'DIRECTORY_SECRET_KEY',
  ].filter(Boolean);
  console.error(`${envFile} is missing ${missing.join(', ')} — see .env2.example.`);
  if (env.SUPABASE_URL || env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY) {
    console.error(
      'It has SUPABASE_* names instead. Those mean the corpus project; the directory uses ' +
        'DIRECTORY_* so a deploy cannot point the two at each other. Rename them.',
    );
  }
  process.exit(1);
}

/*
 * The committed copy has to be the project this check just exercised.
 *
 * src/rag/directory.ts carries the directory's URL and publishable key so the
 * extension can reach it, and .env2 carries the same pair for tooling. If they
 * drift, this suite proves one project is safe while every user talks to another
 * — the most reassuring possible way to be wrong. Compared, never printed.
 */
{
  const mod = readFileSync(resolve(here, '..', 'src/rag/directory.ts'), 'utf8');
  const got = (k) => mod.match(new RegExp(`${k}: '([^']*)'`))?.[1] ?? '';
  const modUrl = got('url');
  const modKey = got('publishableKey');

  /*
   * Only quoted values count, not mentions.
   *
   * The first version grepped the whole file for the prefix and failed on the doc
   * comment that warns against pasting one; the second still matched it, because
   * that comment writes the prefix in markdown backticks. Requiring real key
   * characters after the prefix distinguishes a pasted credential from the
   * sentence telling you not to paste one. A check that rejects a correct file
   * teaches people to ignore it, which is worse than the hole it guards.
   */
  if (/['"`]sb_secret_[A-Za-z0-9_-]{8,}/.test(mod)) {
    console.error('FAIL  src/rag/directory.ts assigns a secret key. It bypasses RLS; remove it.');
    process.exit(1);
  }

  if (modUrl.includes('REPLACE_ME') || modKey.includes('REPLACE_ME')) {
    console.error(
      'FAIL  src/rag/directory.ts still has its placeholder. Paste the directory\n' +
        "      project's URL and sb_publishable_ key into it (never the secret key).",
    );
    process.exit(1);
  }
  if (modUrl.replace(/\/$/, '') !== U || modKey !== PK) {
    console.error(
      'FAIL  src/rag/directory.ts does not match .env2 — the extension would talk to a\n' +
        '      different project than this check just verified.',
    );
    process.exit(1);
  }
  // Not a counted assertion — a precondition. Printing PASS here would make the
  // tally at the bottom disagree with the number of PASS lines above it.
  console.log('ok    committed directory config matches the project under test');
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
    return JSON.parse(text);
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

const signInAnonymously = () =>
  fetch(`${U}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: PK, 'content-type': 'application/json' },
    body: '{}',
  }).then(json);

const codes = (rows) => (Array.isArray(rows) ? rows.map((r) => r.code).sort().join(',') : `ERR ${JSON.stringify(rows)}`);

const A = await signInAnonymously();
const B = await signInAnonymously();
if (!A.access_token || !B.access_token) {
  console.error(
    'could not create an anonymous user. Enable anonymous sign-ins under ' +
      `Authentication → Sign In / Providers. Provider said: ${A.msg ?? B.msg ?? JSON.stringify(A)}`,
  );
  process.exit(1);
}
const idA = A.user.id;
const idB = B.user.id;
ok(A.user.is_anonymous === true, 'anonymous sign-in is enabled');

try {
  await admin('/rest/v1/profiles', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      user_id: idA,
      email: 'owner-probe@example.com',
      project_url: 'https://probe.example.com',
      anon_key: 'probe-key-A',
    }),
  });
  await admin('/rest/v1/sessions', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([
      { code: 'PROBEPRIV', owner_user_id: idA, name: 'private probe', open_join: false },
      { code: 'PROBEOPEN', owner_user_id: idA, name: 'open probe', open_join: true },
    ]),
  });
  const seeded = await admin('/rest/v1/sessions?select=code&code=in.(PROBEPRIV,PROBEOPEN)');
  ok(seeded.length === 2, 'the seed landed, so the reads below have something to hide', `seeded ${seeded.length}`);

  // 42P17: mutually recursive policies. A hard 500 on every read of either table.
  for (const t of ['sessions', 'invites']) {
    const r = await asUser(B.access_token, `/rest/v1/${t}?select=*&limit=1`);
    ok(r?.code !== '42P17', `${t} reads without recursing through its own policy`, JSON.stringify(r));
  }

  const bSees = codes(await asUser(B.access_token, '/rest/v1/sessions?select=code'));
  const aSees = codes(await asUser(A.access_token, '/rest/v1/sessions?select=code'));
  ok(bSees === 'PROBEOPEN', 'a stranger sees the open session and not the private one', `saw [${bSees}]`);
  ok(aSees === 'PROBEOPEN,PROBEPRIV', 'the owner sees both of their own sessions', `saw [${aSees}]`);

  const open = await asUser(B.access_token, '/rest/v1/rpc/credentials_for', {
    method: 'POST',
    body: JSON.stringify({ session_code: 'PROBEOPEN' }),
  });
  const priv = await asUser(B.access_token, '/rest/v1/rpc/credentials_for', {
    method: 'POST',
    body: JSON.stringify({ session_code: 'PROBEPRIV' }),
  });
  ok(
    Array.isArray(open) && open[0]?.anon_key === 'probe-key-A',
    "credentials_for releases the open session's key",
    JSON.stringify(open),
  );
  ok(
    Array.isArray(priv) && priv.length === 0,
    'credentials_for refuses the private session',
    `LEAKED ${JSON.stringify(priv)}`,
  );

  const forged = await asUser(B.access_token, '/rest/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({ code: 'PROBEEVIL', owner_user_id: idA, name: 'forged' }),
  });
  ok(forged?.code === '42501', 'a stranger cannot create a session owned by someone else', JSON.stringify(forged));

  const capped = await asUser(B.access_token, '/rest/v1/demo_usage', {
    method: 'POST',
    body: JSON.stringify({ key: 'probe-must-fail', count: 0 }),
  });
  ok(capped?.code === '42501', 'the demo cap cannot be written by the people it caps', JSON.stringify(capped));
} finally {
  // Runs even when an assertion throws, so a failed run does not leave rows that
  // make the next one lie.
  await admin('/rest/v1/sessions?code=in.(PROBEPRIV,PROBEOPEN,PROBEEVIL)', { method: 'DELETE' });
  await admin(`/rest/v1/profiles?user_id=eq.${idA}`, { method: 'DELETE' });
  await admin('/rest/v1/demo_usage?key=eq.probe-must-fail', { method: 'DELETE' });
  for (const id of [idA, idB]) {
    await fetch(`${U}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: SK, Authorization: `Bearer ${SK}` },
    });
  }
}

/*
 * Profiles as well as sessions. This counted only sessions, so a leaked profile
 * row went unnoticed and was later found sitting in the live directory — exactly
 * the residue a cleanup check exists to catch.
 */
const leftSessions = await admin('/rest/v1/sessions?select=code&code=like.PROBE*');
const leftProfiles = await admin('/rest/v1/profiles?select=user_id&email=like.*probe*');
const left =
  (Array.isArray(leftSessions) ? leftSessions.length : 0) +
  (Array.isArray(leftProfiles) ? leftProfiles.length : 0);
console.log(`\ncleanup: ${left} probe row(s) left behind (0 expected)`);
console.log(`${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
