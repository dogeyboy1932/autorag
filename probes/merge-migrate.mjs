/**
 * One-off: copy the old corpus project's passages into the one Autorag project.
 *
 *   node probes/merge-migrate.mjs            # dry run: says what it would copy
 *   node probes/merge-migrate.mjs --apply    # copies, then verifies the counts
 *
 * Reads `.env`: SUPABASE_URL / SUPABASE_SECRET_KEY are the old corpus project,
 * DIRECTORY_URL / DIRECTORY_SECRET_KEY the project everything now lives in. Both
 * keys bypass RLS, which is the point — this moves other people's rows on their
 * behalf — so it runs here and never ships.
 *
 * ## What changes on the way
 *
 * - `user_id`: auth users are per project, so the same person has a different id in
 *   each. Mapped by email; the run refuses to start if anyone cannot be mapped,
 *   rather than leaving rows that belong to nobody.
 * - A null `user_id` was a member of a shared session writing as the `anon` role.
 *   Nobody writes like that any more, so those rows go to the session's owner.
 * - `sessions.shared` comes from the old project's own sessions table, which is
 *   where it used to live.
 *
 * The old project is only ever read. It stays as it was, as a backup.
 *
 * Idempotent: rows are upserted by id, so a second run changes nothing.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(resolve(root, '.env'), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const OLD = { url: env.SUPABASE_URL, key: env.SUPABASE_SECRET_KEY };
const NEW = { url: env.DIRECTORY_URL, key: env.DIRECTORY_SECRET_KEY };
for (const [name, p] of Object.entries({ OLD, NEW })) {
  if (!p.url || !p.key) throw new Error(`${name} project is missing from .env`);
}
const apply = process.argv.includes('--apply');

const headers = (p, extra = {}) => ({
  apikey: p.key,
  Authorization: `Bearer ${p.key}`,
  'content-type': 'application/json',
  ...extra,
});

async function get(p, path) {
  const res = await fetch(`${p.url}/${path}`, { headers: headers(p) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function upsert(p, table, rows) {
  if (!rows.length) return;
  const res = await fetch(`${p.url}/rest/v1/${table}?on_conflict=id`, {
    method: 'POST',
    headers: headers(p, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`upsert ${table}: ${res.status} ${await res.text()}`);
}

async function count(p, table) {
  const res = await fetch(`${p.url}/rest/v1/${table}?select=id`, {
    headers: headers(p, { Prefer: 'count=exact', Range: '0-0' }),
  });
  return Number(res.headers.get('content-range')?.split('/')[1] ?? NaN);
}

const users = async (p) => (await get(p, 'auth/v1/admin/users?per_page=1000')).users;

// ------------------------------------------------------------- the mapping
const oldUsers = await users(OLD);
const newByEmail = new Map(
  (await users(NEW)).filter((u) => u.email).map((u) => [u.email.toLowerCase(), u.id]),
);
const idMap = new Map();
const unmapped = [];
for (const u of oldUsers) {
  const id = u.email && newByEmail.get(u.email.toLowerCase());
  if (id) idMap.set(u.id, id);
  else unmapped.push(u.email ?? u.id);
}
if (unmapped.length) {
  throw new Error(`No account in the new project for: ${unmapped.join(', ')}. Nothing was copied.`);
}

const newSessions = await get(NEW, 'rest/v1/sessions?select=code,owner_user_id');
const ownerOf = new Map(newSessions.map((s) => [s.code, s.owner_user_id]));

let reownedToSession = 0;
const reowned = (row) => {
  if (row.user_id) return { ...row, user_id: idMap.get(row.user_id) };
  const owner = ownerOf.get(row.session_id);
  if (!owner) throw new Error(`${row.id}: no user, and session ${row.session_id} has no owner`);
  reownedToSession++;
  return { ...row, user_id: owner };
};

// `fts` is generated, so it is never written — only what a client would send.
const COLUMNS = {
  sources: 'id,user_id,session_id,url,title,ingested_at,stale,stale_reason,tags',
  chunks:
    'id,user_id,session_id,source_id,text,ordinal,embedding,status,conflicts,ingested_at,decided_at,rejection_reason,note',
  deletions: 'id,user_id,session_id,kind,at',
};

const plan = {};
for (const [table, cols] of Object.entries(COLUMNS)) {
  plan[table] = (await get(OLD, `rest/v1/${table}?select=${cols}`)).map(reowned);
}
const oldSessions = await get(OLD, 'rest/v1/sessions?select=id,shared');
const flags = oldSessions.filter((s) => ownerOf.has(s.id)).map((s) => ({ code: s.id, shared: s.shared }));
const orphanSessions = oldSessions.filter((s) => !ownerOf.has(s.id)).map((s) => s.id);

console.log(`users mapped by email: ${idMap.size}`);
for (const [t, rows] of Object.entries(plan)) console.log(`${t}: ${rows.length} row(s)`);
console.log(`rows with no user, re-owned to their session's owner: ${reownedToSession}`);
console.log(`sessions.shared to set: ${flags.map((f) => `${f.code}=${f.shared}`).join(', ') || 'none'}`);
if (orphanSessions.length) {
  console.log(`old sessions with no row in the new project (skipped): ${orphanSessions.join(', ')}`);
}

if (!apply) {
  console.log('\nDry run. Re-run with --apply to copy.');
  process.exit(0);
}

// Sessions first: rows in a session are only reachable once its flags are right.
for (const f of flags) {
  const res = await fetch(`${NEW.url}/rest/v1/sessions?code=eq.${encodeURIComponent(f.code)}`, {
    method: 'PATCH',
    headers: headers(NEW, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ shared: f.shared }),
  });
  if (!res.ok) throw new Error(`session ${f.code}: ${res.status} ${await res.text()}`);
}
for (const [table, rows] of Object.entries(plan)) await upsert(NEW, table, rows);

let bad = 0;
for (const table of Object.keys(COLUMNS)) {
  const [o, n] = [await count(OLD, table), await count(NEW, table)];
  const fine = n >= o;
  if (!fine) bad++;
  console.log(`${fine ? 'PASS' : 'FAIL'}  ${table}: ${o} in the old project, ${n} in the new one`);
}
process.exit(bad ? 1 : 0);
