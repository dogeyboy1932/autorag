/**
 * Does a memory actually cross between two machines?
 *
 *   pnpm ext && pnpm ext:sync          # reads .env (DIRECTORY_URL, DIRECTORY_SECRET_KEY)
 *
 * Two throwaway browser profiles signed into one throwaway anonymous account, both
 * syncing to the real Autorag project. Two profiles rather than one because the
 * claim under test is precisely the thing one profile cannot demonstrate: keep
 * something here, find it there.
 *
 * Against the real project rather than a stand-in, now that there is one project:
 * a stub that spoke PostgREST's shape could never catch a policy that refuses the
 * write, and in a project everyone shares, the policies are the product. The secret
 * key only counts rows and cleans up; the profiles use the account's own token.
 *
 * The tombstone assertion matters most for sync itself. A deletion is the only
 * change that leaves nothing behind to sync, so without tombstones a forgotten
 * source is handed straight back by the next pull — and a resurrection looks
 * exactly like a sync that worked. The containment assertion matters most for
 * privacy: syncing into a session must never carry a personal passage with it.
 */
import puppeteer from 'puppeteer-core';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../extension/dist');
const env = Object.fromEntries(
  readFileSync(resolve(here, '../.env'), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const mod = readFileSync(resolve(here, '../src/rag/directory.ts'), 'utf8');
const U = env.DIRECTORY_URL.replace(/\/$/, '');
const PK = mod.match(/publishableKey: '([^']*)'/)[1];
const SK = env.DIRECTORY_SECRET_KEY;

const admin = (path, init = {}) =>
  fetch(`${U}${path}`, {
    ...init,
    headers: { apikey: SK, Authorization: `Bearer ${SK}`, 'content-type': 'application/json', ...init.headers },
  }).then(async (r) => (r.status === 204 ? null : r.json()));

// One account, two machines.
const account = await fetch(`${U}/auth/v1/signup`, {
  method: 'POST',
  headers: { apikey: PK, 'content-type': 'application/json' },
  body: '{}',
}).then((r) => r.json());
if (!account.access_token) throw new Error(`anonymous sign-in failed: ${JSON.stringify(account)}`);
const uid = account.user.id;
const CLOUD = {
  email: '',
  directory: { accessToken: account.access_token, refreshToken: account.refresh_token, userId: uid },
};
const mine = async (table, extra = '') =>
  (await admin(`/rest/v1/${table}?select=id,session_id&user_id=eq.${uid}${extra}`)) ?? [];

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
const send = (p, req) =>
  p.evaluate(
    (r) => new Promise((res) => chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'p', request: r }, res)),
    req,
  );
const must = async (p, req) => {
  const res = await send(p, req);
  if (!res?.ok) throw new Error(`${req.kind}: ${res?.error ?? 'no reply'}`);
  return res.data;
};

let A;
let B;
let ok = false;
try {
  // --- Profile A: keep, approve, sync up ---
  A = await panelIn('autorag-A-');
  await must(A.p, {
    kind: 'ingest',
    text: 'Tidal stream generators extract kinetic energy from moving water much as wind turbines extract it from moving air, and the resource is predictable years ahead.',
    sourceUrl: 'https://example.com/tidal',
    title: 'Tidal power',
  });
  const pend = await must(A.p, { kind: 'listPending' });
  await must(A.p, { kind: 'approve', chunkIds: pend.map((c) => c.chunk_id) });
  console.log('A synced:', JSON.stringify(await must(A.p, { kind: 'sync', cloud: CLOUD })));
  const up = await mine('chunks');
  console.log('project now holds:', up.length, 'chunk(s) for this account');

  // --- Profile B: fresh, sync down ---
  B = await panelIn('autorag-B-');
  console.log('B before:', (await must(B.p, { kind: 'stats' })).chunk_count, 'chunks');
  console.log('B synced:', JSON.stringify(await must(B.p, { kind: 'sync', cloud: CLOUD })));
  const found = await must(B.p, { kind: 'answer', question: 'Is tidal power predictable?' });
  console.log('B recalls it:', found.hits.length, 'hit(s) |', JSON.stringify(found.hits[0]?.source?.url));

  // --- Tombstones: forget on B, sync both, confirm it stays gone on A ---
  const srcs = await must(B.p, { kind: 'listSources' });
  await must(B.p, { kind: 'forget', sourceId: srcs[0].source_id });
  await must(B.p, { kind: 'sync', cloud: CLOUD });
  await must(A.p, { kind: 'sync', cloud: CLOUD });
  const afterA = await must(A.p, { kind: 'stats' });
  console.log('after forget on B → A has', afterA.chunk_count, 'chunks (0 = correct, resurrection = bug)');

  /*
   * --- Containment ---
   *
   * Everything above is the personal corpus. Connected to a *session*, does a
   * privately kept passage stay put? A keeps something personal, then syncs into
   * session 'TEAMPROBE'. Nothing of A's personal corpus may reach that session.
   */
  await must(A.p, {
    kind: 'ingest',
    text: 'A private note about salary negotiation that must never be shared with the team session.',
    sourceUrl: 'https://example.com/private',
    title: 'Private note',
  });
  const pend2 = await must(A.p, { kind: 'listPending' });
  await must(A.p, { kind: 'approve', chunkIds: pend2.map((c) => c.chunk_id) });
  // Unknown session: the sync may be refused by RLS, which is fine — what matters
  // is that nothing personal lands under it either way.
  await send(A.p, { kind: 'sync', cloud: { ...CLOUD, sessionId: 'TEAMPROBE' } });
  const leaked = await mine('chunks', '&session_id=eq.TEAMPROBE');
  console.log('rows pushed into TEAMPROBE:', leaked.length, '(0 = correct, anything else is a disclosure)');

  ok = afterA.chunk_count === 0 && found.hits.length > 0 && up.length > 0 && leaked.length === 0;
} finally {
  await A?.b.close();
  await B?.b.close();
  // Deleting the account cascades to every row it kept.
  await fetch(`${U}/auth/v1/admin/users/${uid}`, {
    method: 'DELETE',
    headers: { apikey: SK, Authorization: `Bearer ${SK}` },
  });
}
const left = (await mine('sources')).length + (await mine('chunks')).length + (await mine('deletions')).length;
console.log(`cleanup: ${left} row(s) left behind (0 expected)`);

console.log(`\n${ok && !left ? 'PASS' : 'FAIL'} — memory crossed profiles, stayed deleted, and private stayed private`);
process.exit(ok && !left ? 0 : 1);
