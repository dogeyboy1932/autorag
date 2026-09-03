/**
 * Can two people actually share one memory?
 *
 *   pnpm ext && pnpm session:check
 *
 * Two throwaway browser profiles against the *real* directory (.env2) and the
 * *real* corpus project (.env), because everything interesting here is a thing a
 * stand-in cannot have: two auth systems with unrelated user ids, a
 * security-definer function deciding who may hold someone else's credentials, and
 * row-level security in a database this code does not own.
 *
 * A signs up, creates a session, keeps a passage into it, and invites B. B signs
 * up, sees the invitation, joins by code, and must end up holding A's passage —
 * out of A's project, which B reaches only because `credentials_for` agreed to
 * hand over the key.
 *
 * Everything it creates it deletes: rows, sessions, invites, profiles, and both
 * auth users in both projects. A failed run cleans up too, or the next one starts
 * from a corpus that makes it lie.
 */
import puppeteer from 'puppeteer-core';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = resolve(root, 'extension/dist');

const readEnv = (name) => {
  try {
    return Object.fromEntries(
      readFileSync(resolve(root, name), 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
        .map((l) => [
          l.slice(0, l.indexOf('=')).trim(),
          l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, ''),
        ]),
    );
  } catch {
    return null;
  }
};

const corpus = readEnv('.env');
const directory = readEnv('.env2');
if (!corpus?.SUPABASE_URL || !directory?.SUPABASE_URL) {
  console.log('SKIP  .env (corpus) and .env2 (directory) are both needed');
  process.exit(0);
}

const stamp = Date.now();
const A_EMAIL = `probe-a-${stamp}@example.com`;
const B_EMAIL = `probe-b-${stamp}@example.com`;
const PASSWORD = 'probe-password-1234';

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

const admin = (env, path, init = {}) =>
  fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });

async function panelIn(profile) {
  const b = await puppeteer.launch({
    executablePath: '/snap/bin/brave',
    headless: false,
    userDataDir: mkdtempSync(join(tmpdir(), profile)),
    args: ['--no-first-run', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let t;
  for (let i = 0; i < 40 && !t; i++) {
    t = b.targets().find((x) => x.url().includes('/background.js'));
    if (!t) await new Promise((r) => setTimeout(r, 250));
  }
  const id = new URL((await t.worker()).url()).host;
  const p = await b.newPage();
  await p.goto(`chrome-extension://${id}/sidepanel.html`);
  await p
    .waitForFunction(() => document.body.innerText.includes('model ready'), { timeout: 180000 })
    .catch(() => {});
  return { b, p };
}

/**
 * Persist the active session the way the panel does.
 *
 * Capture reads which session is open from storage rather than from the request,
 * precisely so that four different capture paths cannot disagree — so a probe
 * that passed it in the message would be exercising a route no user takes. This
 * writes it where the panel writes it.
 */
const setCloud = (p, cloud) =>
  p.evaluate((c) => chrome.storage.local.set({ cloud: c }), cloud);

const send = (p, request) =>
  p.evaluate(
    (r) =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'p', request: r }, res),
      ),
    request,
  );

const CLOUD = { url: corpus.SUPABASE_URL, anonKey: corpus.SUPABASE_PUBLISHABLE_KEY };

/**
 * Users are created through the admin API rather than by signing up.
 *
 * A project with "Confirm email" on tries to send mail on every signup, and the
 * free tier's rate limit then refuses the second one — so a probe that signed up
 * would pass or fail depending on how recently it had last run, which is not a
 * test. `email_confirm: true` makes the account immediately usable and sends
 * nothing. The signup path itself is Supabase's concern; sessions are what this
 * file is about.
 */
async function makeUser(env, email) {
  const res = await admin(env, 'auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`could not create ${email}: ${body.msg ?? JSON.stringify(body)}`);
  return body.id;
}

let A;
let B;
let code = null;
const users = [];

try {
  // ---- A signs up: an account in their own project, and one in the directory --
  users.push({ env: corpus, id: await makeUser(corpus, A_EMAIL) });
  users.push({ env: directory, id: await makeUser(directory, A_EMAIL) });
  users.push({ env: corpus, id: await makeUser(corpus, B_EMAIL) });
  users.push({ env: directory, id: await makeUser(directory, B_EMAIL) });

  A = await panelIn('autorag-sess-A-');
  const aIn = await send(A.p, {
    kind: 'cloudSignIn',
    cloud: CLOUD,
    email: A_EMAIL,
    password: PASSWORD,
    create: false,
  });
  ok(aIn?.ok && aIn.data?.accessToken, 'A signs in to their own corpus project', aIn?.error);
  ok(
    aIn?.data?.directory?.userId,
    'the same sign-in registers A with the directory',
    aIn?.data?.directoryError ?? 'no directory account came back',
  );
  const aCloud = { ...CLOUD, ...aIn.data };

  // A profile row is what lets anyone else resolve A's sessions at all.
  const profile = await (
    await admin(directory, `rest/v1/profiles?select=project_url&user_id=eq.${aIn.data.directory.userId}`)
  ).json();
  ok(
    profile[0]?.project_url === CLOUD.url,
    "A's profile records where their corpus lives",
    JSON.stringify(profile),
  );

  // ---- A creates a session and keeps something into it ----------------------
  const made = await send(A.p, { kind: 'createSession', cloud: aCloud, name: 'Probe Session' });
  ok(made?.ok && made.data?.code, 'A creates a session', made?.error);
  code = made?.data?.code;

  const inSession = { ...aCloud, sessionId: code };
  await setCloud(A.p, inSession);
  await send(A.p, {
    kind: 'ingest',
    text: 'Tidal stream generators extract kinetic energy from moving water, and the resource is predictable years ahead.',
    sourceUrl: 'https://example.com/probe-tidal',
    title: 'Probe tidal',
  });
  const pend = (await send(A.p, { kind: 'listPending' })).data;
  await send(A.p, { kind: 'approve', chunkIds: pend.map((c) => c.chunk_id) });
  const pushed = await send(A.p, { kind: 'sync', cloud: inSession });
  ok(pushed?.ok, 'A syncs the session up', pushed?.error);

  const rows = await (
    await admin(corpus, `rest/v1/chunks?select=id,session_id&session_id=eq.${code}`)
  ).json();
  ok(rows.length > 0, "the passage is stored under the session in A's project", JSON.stringify(rows));

  // ---- B signs up and is invited -------------------------------------------
  B = await panelIn('autorag-sess-B-');
  const bIn = await send(B.p, {
    kind: 'cloudSignIn',
    cloud: CLOUD,
    email: B_EMAIL,
    password: PASSWORD,
    create: false,
  });
  ok(bIn?.ok && bIn.data?.directory?.userId, 'B signs in and reaches the directory', bIn?.error);
  const bCloud = { ...CLOUD, ...bIn.data };

  // Before the invite, the code must be useless to B. This is the assertion that
  // decides whether a session is private at all.
  const early = await send(B.p, { kind: 'joinSession', cloud: bCloud, code });
  ok(!early?.ok, 'an uninvited stranger cannot join by code alone', 'JOINED WITHOUT AN INVITE');

  const invited = await send(A.p, {
    kind: 'inviteToSession',
    cloud: aCloud,
    code,
    email: B_EMAIL,
  });
  ok(invited?.ok, 'A invites B by email', invited?.error);

  const listed = await send(B.p, { kind: 'listSessions', cloud: bCloud });
  ok(
    Array.isArray(listed?.data) && listed.data.some((s) => s.code === code),
    'B now sees the session they were invited to',
    JSON.stringify(listed?.data ?? listed?.error),
  );

  // ---- B joins and ends up holding A's passage ------------------------------
  const joined = await send(B.p, { kind: 'joinSession', cloud: bCloud, code });
  ok(joined?.ok && joined.data?.host?.url === CLOUD.url, 'B joins and is pointed at A’s project', joined?.error);

  const bInSession = { ...bCloud, sessionId: code, host: joined.data.host };
  await setCloud(B.p, bInSession);
  const bSync = await send(B.p, { kind: 'sync', cloud: bInSession });
  ok(bSync?.ok && bSync.data.pulled > 0, "B pulls A's passage", JSON.stringify(bSync?.data ?? bSync?.error));

  const found = (await send(B.p, { kind: 'answer', question: 'Is tidal power predictable?' })).data;
  ok(
    found?.hits?.[0]?.source?.url === 'https://example.com/probe-tidal',
    'B can recall what A kept',
    JSON.stringify(found?.hits?.length ?? 0),
  );
} catch (err) {
  ok(false, 'run completed', String(err));
} finally {
  // ---- put everything back -------------------------------------------------
  // Browsers first. Auto-sync fires on corpus changes, so a profile that is still
  // open can push a row back in between the delete and the count — which is how
  // the first version of this reported one row left behind and no reason.
  await A?.b.close();
  await B?.b.close();
  try {
    if (code) {
      await admin(corpus, `rest/v1/chunks?session_id=eq.${code}`, { method: 'DELETE' });
      await admin(corpus, `rest/v1/sources?session_id=eq.${code}`, { method: 'DELETE' });
      await admin(corpus, `rest/v1/deletions?session_id=eq.${code}`, { method: 'DELETE' });
      await admin(corpus, `rest/v1/sessions?id=eq.${code}`, { method: 'DELETE' });
      await admin(directory, `rest/v1/invites?session_code=eq.${code}`, { method: 'DELETE' });
      await admin(directory, `rest/v1/sessions?code=eq.${code}`, { method: 'DELETE' });
    }
    for (const u of users) {
      await admin(u.env, `rest/v1/profiles?user_id=eq.${u.id}`, { method: 'DELETE' }).catch(() => {});
      await admin(u.env, `auth/v1/admin/users/${u.id}`, { method: 'DELETE' }).catch(() => {});
    }
    const left = await (
      await admin(corpus, `rest/v1/chunks?select=id&session_id=eq.${code ?? 'none'}`)
    ).json();
    console.log(`\ncleanup: ${Array.isArray(left) ? left.length : '?'} probe rows left (0 expected)`);
  } catch (err) {
    console.log('cleanup problem:', String(err));
  }
}

console.log(`${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
