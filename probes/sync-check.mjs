/**
 * Does a memory actually cross between two machines?
 *
 *   pnpm ext && node probes/sync-check.mjs [--executable <path>]
 *
 * Two throwaway browser profiles and a stand-in for Supabase. Two profiles rather
 * than one because the claim under test is precisely the thing one profile cannot
 * demonstrate: keep something here, find it there.
 *
 * The stand-in speaks PostgREST's shape (upsert with merge-duplicates, select,
 * delete by `id=in.(...)`) over in-memory tables. Faking it keeps the check free,
 * offline and deterministic; what it cannot catch is a schema or RLS mistake in a
 * real project, which is what the by-hand test in HUMAN-TASKS is for.
 *
 * The last assertion is the one that matters most. A deletion is the only change
 * that leaves nothing behind to sync, so without tombstones a forgotten source is
 * handed straight back by the next pull — and a resurrection looks exactly like a
 * sync that worked.
 */
import puppeteer from 'puppeteer-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';

// A stand-in for Supabase: PostgREST-shaped upsert/select/delete over in-memory tables.
const tables = { sources: new Map(), chunks: new Map(), deletions: new Map() };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const name = u.pathname.replace('/rest/v1/', '').split('?')[0];
  if (u.pathname.startsWith('/auth/v1/')) {
    res.writeHead(200, {'content-type':'application/json'});
    return res.end(JSON.stringify({ access_token: 'tok', refresh_token: 'ref' }));
  }
  const t = tables[name];
  if (!t) { res.writeHead(404); return res.end('{}'); }
  /*
   * Honour `session_id`, because the alternative is a check that cannot fail.
   *
   * This stub ignored the query string entirely, so every select returned every
   * row and the session scoping added on top of it was never exercised — the
   * suite went green while the one bug that actually matters here, a private
   * passage leaking into a shared session, would have sailed straight through.
   * PostgREST filters; so does this.
   */
  const scoped = (rows) => {
    const eq = /session_id=eq\.([^&]*)/.exec(u.search);
    if (eq) return rows.filter((r) => r.session_id === decodeURIComponent(eq[1]));
    if (/session_id=is\.null/.test(u.search)) return rows.filter((r) => r.session_id == null);
    return rows;
  };
  if (req.method === 'GET') {
    res.writeHead(200, {'content-type':'application/json'});
    return res.end(JSON.stringify(scoped([...t.values()])));
  }
  if (req.method === 'DELETE') {
    const m = /id=in\.\(([^)]*)\)/.exec(u.search) ?? [];
    const ids = new Set((m[1] ?? '').split(','));
    for (const row of scoped([...t.values()])) if (ids.has(row.id)) t.delete(row.id);
    res.writeHead(204); return res.end();
  }
  let body = ''; for await (const c of req) body += c;
  for (const row of JSON.parse(body)) {
    /*
     * Behave like Postgres, not like a permissive map. `vector(384)` accepts
     * pgvector's text form '[0.1,0.2,…]' and rejects a JSON array — and the first
     * version of this stub accepted either, so a real project was the only thing
     * that caught it. A fake backend is only worth having if it refuses what the
     * real one refuses.
     */
    if (name === 'chunks' && !(typeof row.embedding === 'string' && row.embedding.startsWith('['))) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: 'column "embedding" is of type vector but expression is of type json' }));
    }
    t.set(row.id, row);
  }
  res.writeHead(201); res.end();
});
await new Promise(r => server.listen(8891, r));

const EXT = resolve('/home/dogeyboy19/Desktop/gtmp/AutoRag/extension/dist');
const CLOUD = { url: 'http://localhost:8891', anonKey: 'anon', accessToken: 'tok', refreshToken: 'ref', email: 'a@b.c' };

async function panelIn(profile) {
  const b = await puppeteer.launch({ executablePath: '/snap/bin/brave', headless: false,
    userDataDir: mkdtempSync(join(tmpdir(), profile)),
    args: ['--no-first-run', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let t; for (let i=0;i<40&&!t;i++){t=b.targets().find(x=>x.url().includes('/background.js')); if(!t) await new Promise(r=>setTimeout(r,250));}
  const id = new URL((await t.worker()).url()).host;
  const p = await b.newPage();
  await p.goto(`chrome-extension://${id}/sidepanel.html`);
  await p.waitForFunction(() => document.body.innerText.includes('model ready'), { timeout: 180000 }).catch(()=>{});
  return { b, p };
}
const send = (p, req) => p.evaluate((r) => new Promise(res =>
  chrome.runtime.sendMessage({ __autorag:true, to:'worker', id:'p', request:r }, res)), req);

// --- Profile A: keep, approve, sync up ---
const A = await panelIn('autorag-A-');
await send(A.p, { kind:'ingest', text:'Tidal stream generators extract kinetic energy from moving water much as wind turbines extract it from moving air, and the resource is predictable years ahead.', sourceUrl:'https://example.com/tidal', title:'Tidal power' });
const pend = (await send(A.p, { kind:'listPending' })).data;
await send(A.p, { kind:'approve', chunkIds: pend.map(c=>c.chunk_id) });
console.log('A synced:', JSON.stringify((await send(A.p, { kind:'sync', cloud: CLOUD })).data));
console.log('cloud now holds:', tables.sources.size, 'source(s),', tables.chunks.size, 'chunk(s)');

// --- Profile B: fresh, sync down ---
const B = await panelIn('autorag-B-');
console.log('B before:', (await send(B.p, { kind:'stats' })).data.chunk_count, 'chunks');
console.log('B synced:', JSON.stringify((await send(B.p, { kind:'sync', cloud: CLOUD })).data));
const found = (await send(B.p, { kind:'answer', question:'Is tidal power predictable?' })).data;
console.log('B recalls it:', found.hits.length, 'hit(s) |', JSON.stringify(found.hits[0]?.source?.url));

// --- The tombstone test: forget on B, sync, confirm it stays gone on A ---
const srcs = (await send(B.p, { kind:'listSources' })).data;
await send(B.p, { kind:'forget', sourceId: srcs[0].source_id });
await send(B.p, { kind:'sync', cloud: CLOUD });
await send(A.p, { kind:'sync', cloud: CLOUD });
const afterA = (await send(A.p, { kind:'stats' })).data;
console.log('after forget on B → A has', afterA.chunk_count, 'chunks (0 = correct, resurrection = bug)');
/*
 * --- The containment test ---
 *
 * Everything above runs with no session, so it only proves the private path. The
 * question that decides whether sessions are safe to ship is the opposite one:
 * connected to a *shared* session, does a privately kept passage stay put?
 *
 * A keeps something with no session and syncs into session 'team-1'. Nothing of
 * A's should reach that session's rows. This is the disclosure nobody would
 * notice on their own machine, so it is asserted rather than assumed.
 */
await send(A.p, { kind:'ingest', text:'A private note about salary negotiation that must never be shared with the team session.', sourceUrl:'https://example.com/private', title:'Private note' });
const pend2 = (await send(A.p, { kind:'listPending' })).data;
await send(A.p, { kind:'approve', chunkIds: pend2.map(c=>c.chunk_id) });

const before = tables.chunks.size;
const shared = await send(A.p, { kind:'sync', cloud: { ...CLOUD, sessionId: 'team-1' } });
const leaked = [...tables.chunks.values()].filter(r => r.session_id === 'team-1');
console.log('private chunks locally:', (await send(A.p, { kind:'stats' })).data.chunk_count);
console.log('rows pushed into team-1:', leaked.length, '(0 = correct, anything else is a disclosure)');
console.log('shared sync reported:', JSON.stringify(shared.data));

const contained = leaked.length === 0;

const ok = afterA.chunk_count === 0 && found.hits.length > 0 && contained;
console.log(`\n${ok ? 'PASS' : 'FAIL'} — memory crossed profiles, stayed deleted, and private stayed private`);
await A.b.close(); await B.b.close(); server.close();
process.exit(ok ? 0 : 1);
