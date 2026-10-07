/**
 * Can two people actually share one memory?
 *
 *   pnpm ext && pnpm session:check          # reads .env (DIRECTORY_URL, DIRECTORY_SECRET_KEY)
 *
 * Two throwaway browser profiles against the *real* Autorag project, because what
 * is interesting here is a thing a stand-in cannot have: row-level security deciding,
 * in a database everyone shares, which person may read which passage.
 *
 * A signs in, creates a session, keeps a passage into it, and invites B. B signs
 * in, is refused before the invite, joins after it, and must end up holding A's
 * passage — with the same kind of account A has, and nothing else.
 *
 * Everything it creates it deletes: deleting the users cascades to their sessions,
 * invites and rows. A failed run cleans up too, or the next one starts from a
 * corpus that makes it lie.
 */
import puppeteer from 'puppeteer-core';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = resolve(root, 'extension/dist');

let env;
try {
  env = Object.fromEntries(
    readFileSync(resolve(root, '.env'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
  );
} catch {
  env = {};
}
if (!env.DIRECTORY_URL || !env.DIRECTORY_SECRET_KEY) {
  console.log('SKIP  needs DIRECTORY_URL and DIRECTORY_SECRET_KEY in .env');
  process.exit(0);
}
const U = env.DIRECTORY_URL.replace(/\/$/, '');
const SK = env.DIRECTORY_SECRET_KEY;
const PK = readFileSync(resolve(root, 'src/rag/directory.ts'), 'utf8').match(/publishableKey: '([^']*)'/)[1];

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

const admin = (path, init = {}) =>
  fetch(`${U}/${path}`, {
    ...init,
    headers: { apikey: SK, Authorization: `Bearer ${SK}`, 'content-type': 'application/json', ...init.headers },
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
  return { b, p };
}

/**
 * Persist the active session the way the panel does.
 *
 * Capture reads which session is open from storage rather than from the request,
 * precisely so that four different capture paths cannot disagree — so a probe
 * that passed it in the message would be exercising a route no user takes.
 */
const setCloud = (p, cloud) => p.evaluate((c) => chrome.storage.local.set({ cloud: c }), cloud);

const send = (p, request) =>
  p.evaluate(
    (r) => new Promise((res) => chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'p', request: r }, res)),
    request,
  );

/**
 * Users are created through the admin API rather than by signing up: a project
 * with "Confirm email" on would otherwise rate-limit the second signup, and the
 * probe would pass or fail by how recently it last ran.
 */
async function makeUser(email) {
  const res = await admin('auth/v1/admin/users', {
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
let openCode = null;
const users = [];

try {
  users.push(await makeUser(A_EMAIL), await makeUser(B_EMAIL));

  // ---- A signs in: one account, which is also what syncs --------------------
  A = await panelIn('autorag-sess-A-');
  const aIn = await send(A.p, { kind: 'signIn', email: A_EMAIL, password: PASSWORD });
  ok(aIn?.ok && aIn.data?.directory?.userId, 'A signs in with an email and a password', aIn?.error);
  const aCloud = { email: A_EMAIL, directory: aIn.data.directory };

  // ---- A creates a session and keeps something into it ----------------------
  const made = await send(A.p, { kind: 'createSession', cloud: aCloud, name: 'Probe Session' });
  ok(made?.ok && made.data?.code, 'A creates a session — no project of their own needed', made?.error);
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

  const rows = await (await admin(`rest/v1/chunks?select=id,user_id&session_id=eq.${code}`)).json();
  ok(
    Array.isArray(rows) && rows.length > 0 && rows.every((r) => r.user_id === aIn.data.directory.userId),
    'the passage is stored under the session, stamped as A’s',
    JSON.stringify(rows),
  );

  // ---- B signs in and is invited -------------------------------------------
  B = await panelIn('autorag-sess-B-');
  const bIn = await send(B.p, { kind: 'signIn', email: B_EMAIL, password: PASSWORD });
  ok(bIn?.ok && bIn.data?.directory?.userId, 'B signs in with the same kind of account', bIn?.error);
  const bCloud = { email: B_EMAIL, directory: bIn.data.directory };

  /*
   * Sessions are created shared — anyone holding the code may join — so to test
   * the invite path, A's session is made invite-only here, as the owner would.
   */
  await admin(`rest/v1/sessions?code=eq.${code}`, { method: 'PATCH', body: JSON.stringify({ shared: false }) });
  const early = await send(B.p, { kind: 'joinSession', cloud: bCloud, code });
  ok(!early?.ok, 'an uninvited stranger cannot join an invite-only session by code', 'JOINED WITHOUT AN INVITE');
  const earlyPull = await send(B.p, { kind: 'sync', cloud: { ...bCloud, sessionId: code } });
  ok(!earlyPull?.ok || earlyPull.data.pulled === 0, 'nor pull its passages by naming the session', JSON.stringify(earlyPull?.data));

  const invited = await send(A.p, { kind: 'inviteToSession', cloud: aCloud, code, email: B_EMAIL });
  ok(invited?.ok, 'A invites B by email', invited?.error);

  // ---- B joins and ends up holding A's passage ------------------------------
  const joined = await send(B.p, { kind: 'joinSession', cloud: bCloud, code });
  ok(joined?.ok && joined.data?.code === code, 'B joins once invited', joined?.error);

  const bInSession = { ...bCloud, sessionId: code };
  await setCloud(B.p, bInSession);
  const bSync = await send(B.p, { kind: 'sync', cloud: bInSession });
  ok(bSync?.ok && bSync.data.pulled > 0, "B pulls A's passage", JSON.stringify(bSync?.data ?? bSync?.error));

  const found = (await send(B.p, { kind: 'answer', question: 'Is tidal power predictable?' })).data;
  ok(
    found?.hits?.[0]?.source?.url === 'https://example.com/probe-tidal',
    'B can recall what A kept',
    JSON.stringify(found?.hits?.length ?? 0),
  );

  // ---- demo mode: a stranger with no account at all ------------------------
  const openMade = await send(A.p, { kind: 'createSession', cloud: aCloud, name: 'Probe Open', openJoin: true });
  ok(openMade?.ok && openMade.data?.code, 'A publishes a session open to anyone', openMade?.error);
  openCode = openMade?.data?.code;
  await setCloud(A.p, { ...aCloud, sessionId: openCode });
  await send(A.p, {
    kind: 'ingest',
    text: 'Offshore wind capacity factors commonly exceed forty percent, well above most onshore sites.',
    sourceUrl: 'https://example.com/probe-wind',
    title: 'Probe wind',
  });
  const pend2 = (await send(A.p, { kind: 'listPending' })).data;
  await send(A.p, { kind: 'approve', chunkIds: pend2.map((c) => c.chunk_id) });
  await send(A.p, { kind: 'sync', cloud: { ...aCloud, sessionId: openCode } });

  // As the web app's demo does it: an anonymous account and nothing else.
  const anon = await (
    await fetch(`${U}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: PK, 'content-type': 'application/json' },
      body: '{}',
    })
  ).json();
  ok(Boolean(anon.access_token), 'a visitor with no account can sign in anonymously', anon.msg);
  if (anon.user?.id) users.push(anon.user.id);
  const asAnon = (path) =>
    fetch(`${U}/rest/v1/${path}`, { headers: { apikey: PK, Authorization: `Bearer ${anon.access_token}` } }).then((r) =>
      r.json(),
    );

  const openList = await asAnon('sessions?select=code&open_join=is.true');
  ok(
    Array.isArray(openList) && openList.some((x) => x.code === openCode),
    'the open session is discoverable without being told its code',
    JSON.stringify(openList),
  );
  ok(!openList.some((x) => x.code === code), 'the invite-only session is NOT in that list', 'PRIVATE SESSION LISTED');

  const demoRows = await asAnon(`chunks?select=id&session_id=eq.${openCode}`);
  ok(Array.isArray(demoRows) && demoRows.length > 0, 'the visitor reads the open session’s passages', JSON.stringify(demoRows));
  const deniedRows = await asAnon(`chunks?select=id&session_id=eq.${code}`);
  ok(
    Array.isArray(deniedRows) && deniedRows.length === 0,
    'the same visitor reads nothing of the invite-only session',
    `LEAKED ${JSON.stringify(deniedRows)}`,
  );
} catch (err) {
  ok(false, 'run completed', String(err));
} finally {
  // Browsers first: auto-sync fires on corpus changes, so an open profile can push
  // a row back between the delete and the count.
  await A?.b.close();
  await B?.b.close();
  try {
    // Deleting the users cascades to their sessions, invites and passages.
    for (const id of users) {
      await admin(`auth/v1/admin/users/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    const codes = [code, openCode].filter(Boolean).join(',') || 'none';
    const left = await (await admin(`rest/v1/chunks?select=id&session_id=in.(${codes})`)).json();
    console.log(`\ncleanup: ${Array.isArray(left) ? left.length : '?'} probe rows left (0 expected)`);
  } catch (err) {
    console.log('cleanup problem:', String(err));
  }
}

console.log(`${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
