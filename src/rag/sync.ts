/**
 * Cloud sync — the thing that stops a memory being trapped on one laptop.
 *
 * ## The shape, and why it is a mirror rather than a swap
 *
 * IndexedDB stays the only thing anything reads from. Search, screening, the
 * review queue and Ask are untouched; they never learn that a cloud exists. This
 * module only pushes local rows up and pulls remote rows down.
 *
 * That is deliberate. Moving retrieval to the server would mean re-implementing
 * hybrid ranking in SQL, and `ts_rank_cd` is not BM25 — the lexical half carries
 * short keyword queries, which is most of what people type ("runtime" scores 0.127
 * cosine against the passage that literally contains the runtime). A second ranker
 * would need its own benchmark and would quietly disagree with the first. Mirroring
 * keeps one ranker, one benchmark, and offline use.
 *
 * It is affordable because the corpus is small: 384 floats is 1.5KB, so five
 * thousand passages is about 12MB. Remote ANN search exists for corpora you cannot
 * hold in memory. This is three orders of magnitude short of that.
 *
 * ## Why raw `fetch` and not `supabase-js`
 *
 * PostgREST is a plain REST API and the SDK brings a realtime client, a storage
 * client and a Node-shaped auth stack we would not use. Same reasoning as the
 * Anthropic call in `offscreen/answer.ts`: in an MV3 document, fewer moving parts.
 *
 * ## Why the anon key in client code is not the usual mistake
 *
 * Shipping a database key in an extension normally means anyone with the profile
 * can read or wipe everything. Supabase's anon key is **designed to be public**:
 * it grants nothing on its own, and row-level security scopes every row to the
 * signed-in user's `auth.uid()`. The credential that matters is the session JWT,
 * which is per-user and expires.
 */

import type { Chunk, Source } from '@/src/types';
import {
  allChunks,
  allDeletions,
  allSources,
  applyRemoteDeletion,
  putChunks,
  upsertSource,
  setActiveSession,
} from './store';
import { sessionOf } from './sessions';
import { backendFetch } from './backend';

export interface CloudConfig {
  url: string;
  anonKey: string;
  /**
   * The session this connection mirrors. Absent means the personal corpus —
   * `session_id = 'personal'`, visible to nobody but its owner.
   *
   * This is the whole of what makes a sync safe in a project everyone shares: a
   * run only ever pushes rows already tagged with this session, and only ever
   * reads rows carrying it. A passage kept privately cannot be swept
   * into a shared session by connecting to one, which is the mistake that would
   * matter most and would be discovered by someone else reading your notes.
   */
  sessionId?: string;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  email: string;
  /** The account's id — what sessions, profiles and every passage's `user_id` refer to. */
  userId: string;
}

const rest = (c: CloudConfig, path: string) => `${c.url.replace(/\/$/, '')}/rest/v1/${path}`;
const auth = (c: CloudConfig, path: string) => `${c.url.replace(/\/$/, '')}/auth/v1/${path}`;

function headers(c: CloudConfig, session?: Session): Record<string, string> {
  return {
    'content-type': 'application/json',
    apikey: c.anonKey,
    Authorization: `Bearer ${session?.accessToken ?? c.anonKey}`,
  };
}

/**
 * Reads the provider's own error, and translates the one that is technically
 * accurate and practically useless.
 *
 * "Invalid login credentials" is correct and misleading: a Supabase *dashboard*
 * account is not a user of your *project*. Auth users live per-project, so the
 * email you log into supabase.com with does not exist here until you create it —
 * and the natural reading of the error is "you typed your password wrong", which
 * sends you to retype a password that was never going to work.
 */
async function fail(res: Response): Promise<never> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { message?: string; msg?: string; error_description?: string };
    detail = body.msg ?? body.message ?? body.error_description ?? detail;
  } catch {
    /* keep the status */
  }
  throw new Error(detail);
}

/* ---------------------------------------------------------------------- auth */

/*
 * Signing in happens in `directory.ts` — there is one project and one account, so
 * this module only ever renews a session it was handed.
 */
export async function refresh(c: CloudConfig, session: Session): Promise<Session> {
  const res = await backendFetch(auth(c, 'token?grant_type=refresh_token'), {
    method: 'POST',
    headers: headers(c),
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  });
  if (!res.ok) await fail(res);
  const body = (await res.json()) as { access_token: string; refresh_token: string };
  return { ...session, accessToken: body.access_token, refreshToken: body.refresh_token };
}

/* ---------------------------------------------------------------------- wire */

/**
 * `Float32Array` does not survive JSON, and Postgres `vector` wants a number
 * array. Converting here rather than at the call sites keeps exactly one place
 * where a vector can be mangled.
 */
const rowOfChunk = (c: Chunk, sessionId?: string) => ({
  id: c.id,
  session_id: sessionOf(sessionId),
  source_id: c.sourceId,
  text: c.text,
  ordinal: c.ordinal,
  /*
   * pgvector's input format is a *string* — `'[0.1,0.2,…]'` — not a JSON array.
   * Sent as an array, Postgres refuses the insert with a type error and the table
   * stays empty. The stubbed server in `sync-check.mjs` accepted either, which is
   * exactly the class of mistake a fake backend cannot catch; it took a real
   * project to surface it.
   */
  embedding: `[${Array.from(c.embedding).join(',')}]`,
  status: c.status,
  conflicts: c.conflicts,
  ingested_at: c.ingestedAt,
  decided_at: c.decidedAt ?? null,
  rejection_reason: c.rejectionReason ?? null,
  note: c.note ?? null,
});

type ChunkRow = Omit<ReturnType<typeof rowOfChunk>, 'embedding'> & {
  embedding: string | number[];
};

const chunkOfRow = (r: ChunkRow): Chunk => ({
  id: r.id as Chunk['id'],
  sourceId: r.source_id as Chunk['sourceId'],
  text: r.text,
  ordinal: r.ordinal,
  // Read back as text by PostgREST; tolerate an array in case a future column
  // type or client hands one over.
  embedding: Float32Array.from(
    typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding,
  ),
  status: r.status,
  conflicts: r.conflicts ?? [],
  ingestedAt: r.ingested_at,
  ...(r.decided_at ? { decidedAt: r.decided_at } : {}),
  ...(r.rejection_reason ? { rejectionReason: r.rejection_reason } : {}),
  ...(r.note ? { note: r.note } : {}),
  ...(r.session_id ? { sessionId: r.session_id } : {}),
});

const rowOfSource = (s: Source, sessionId?: string) => ({
  id: s.id,
  session_id: sessionOf(sessionId),
  url: s.url,
  title: s.title,
  ingested_at: s.ingestedAt,
  stale: s.stale,
  stale_reason: s.staleReason ?? null,
  tags: s.tags,
});

type SourceRow = ReturnType<typeof rowOfSource>;

const sourceOfRow = (r: SourceRow): Source => ({
  id: r.id as Source['id'],
  url: r.url,
  title: r.title,
  ingestedAt: r.ingested_at,
  stale: r.stale,
  ...(r.stale_reason ? { staleReason: r.stale_reason } : {}),
  tags: r.tags ?? [],
  ...(r.session_id ? { sessionId: r.session_id } : {}),
});

async function upsert(c: CloudConfig, s: Session, table: string, rows: unknown[]) {
  if (rows.length === 0) return;
  // Chunked because PostgREST and the network both dislike one enormous body, and
  // a first sync of a full corpus is exactly when this runs.
  for (let i = 0; i < rows.length; i += 250) {
    const res = await backendFetch(rest(c, table), {
      method: 'POST',
      headers: { ...headers(c, s), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows.slice(i, i + 250)),
    });
    if (!res.ok) await fail(res);
  }
}

/**
 * Every read is scoped to the active session — one form, no null case.
 *
 * Leaving it unfiltered would work and would be wrong: RLS already hides other
 * people's rows, so an unscoped read looks correct right up until the owner —
 * who can legitimately see every session they host — syncs one and pulls every
 * other session's passages into it.
 */
const scope = (c: CloudConfig) => `session_id=eq.${encodeURIComponent(sessionOf(c.sessionId))}`;

async function selectAll<T>(c: CloudConfig, s: Session, table: string): Promise<T[]> {
  const res = await backendFetch(rest(c, `${table}?select=*&${scope(c)}`), { headers: headers(c, s) });
  if (!res.ok) await fail(res);
  return (await res.json()) as T[];
}

/* ---------------------------------------------------------------------- sync */

export interface SyncResult {
  pushed: number;
  pulled: number;
  deleted: number;
}

/**
 * One full reconcile: push what is here, pull what is not, apply deletions both ways.
 *
 * Whole-set rather than incremental because the corpus is small enough that a
 * delta protocol would be more code and more ways to be subtly wrong. Conflicts
 * resolve last-write-wins on the server (`merge-duplicates`); passage text is
 * effectively immutable and only `status`, `note` and `conflicts` move, so two
 * laptops editing the same passage in the same minute is not a case worth building
 * machinery for.
 *
 * `onProgress` exists because a first sync of a full corpus is one long upload,
 * and silence during it looks identical to a hang — the same reason the model
 * download reports a percentage.
 */
export async function syncNow(
  c: CloudConfig,
  s: Session,
  onProgress?: (message: string) => void,
): Promise<SyncResult> {
  setActiveSession(c.sessionId);
  const [allLocalSources, allLocalChunks, allLocalDeletions] = await Promise.all([
    allSources(),
    allChunks(),
    allDeletions(),
  ]);

  /*
   * A sync touches exactly one session, and everything below works from these
   * three filtered lists rather than the full corpus.
   *
   * This is the line that keeps a private passage private. Push the whole corpus
   * while connected to a shared session and every note you ever kept becomes
   * readable by everyone in it — a disclosure you would not discover yourself,
   * because on your machine nothing looks any different.
   *
   * `?? null` on both sides so that "no session" compares equal to "no session"
   * rather than `undefined !== null` quietly filtering everything out and
   * reporting a successful sync of nothing.
   */
  const inScope = (x: { sessionId?: string }) => sessionOf(x.sessionId) === sessionOf(c.sessionId);

  // Supabase mirrors the complete active session. Retrieval remains approved-only,
  // but pending and rejected rows must also travel so review decisions and
  // conflict history stay consistent across devices.
  const chunks = allLocalChunks.filter((x) => inScope(x));
  const sources = allLocalSources.filter((x) => inScope(x));
  const deletions = allLocalDeletions.filter(inScope);

  /*
   * Deletions go up first, and this ordering is load-bearing. Push rows before
   * tombstones and a source deleted here is re-created from another device's copy
   * in the same run — the resurrection bug, arriving as a "successful" sync.
   */
  if (deletions.length) {
    onProgress?.(`Propagating ${deletions.length} deletion(s)`);
    await upsert(
      c,
      s,
      'deletions',
      deletions.map((d) => ({ id: d.id, kind: d.kind, at: d.at, session_id: sessionOf(c.sessionId) })),
    );
    for (const kind of ['source', 'chunk'] as const) {
      const ids = deletions.filter((d) => d.kind === kind).map((d) => d.id);
      if (!ids.length) continue;
      const table = kind === 'source' ? 'sources' : 'chunks';
      const res = await backendFetch(rest(c, `${table}?id=in.(${ids.join(',')})&${scope(c)}`), {
        method: 'DELETE',
        headers: headers(c, s),
      });
      if (!res.ok) await fail(res);
    }
  }

  onProgress?.(`Uploading ${sources.length} source(s), ${chunks.length} passage(s)`);
  await upsert(c, s, 'sources', sources.map((x) => rowOfSource(x, c.sessionId)));
  await upsert(c, s, 'chunks', chunks.map((x) => rowOfChunk(x, c.sessionId)));

  onProgress?.('Downloading what other devices kept');
  const [remoteSources, remoteChunks, remoteDeletions] = await Promise.all([
    selectAll<SourceRow>(c, s, 'sources'),
    selectAll<ChunkRow>(c, s, 'chunks'),
    selectAll<{ id: string; kind: 'source' | 'chunk'; at: string }>(c, s, 'deletions'),
  ]);

  const haveSource = new Set(sources.map((x) => x.id));
  const haveChunk = new Set(chunks.map((x) => x.id));
  const tombstoned = new Set(remoteDeletions.map((d) => d.id));

  let pulled = 0;
  for (const row of remoteSources) {
    if (haveSource.has(row.id as Source['id']) || tombstoned.has(row.id)) continue;
    await upsertSource(sourceOfRow(row));
    pulled++;
  }
  const newChunks = remoteChunks
    .filter((r) => !haveChunk.has(r.id as Chunk['id']) && !tombstoned.has(r.id))
    .map(chunkOfRow);
  if (newChunks.length) await putChunks(newChunks);
  pulled += newChunks.length;

  // Deletions made elsewhere, applied here.
  let deleted = 0;
  const known = new Set(deletions.map((d) => d.id));
  for (const d of remoteDeletions) {
    if (known.has(d.id)) continue;
    await applyRemoteDeletion(d.id, d.kind, d.at, sessionOf(c.sessionId));
    deleted++;
  }

  return { pushed: sources.length + chunks.length, pulled, deleted };
}

