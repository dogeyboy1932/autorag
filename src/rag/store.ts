/**
 * IndexedDB persistence.
 *
 * This is the whole "memory" claim: the corpus outlives the session, the tab,
 * and the agent. `amendments.md` A6 makes cross-session resume one of the two
 * demo beats that answer "why not just paste it into context".
 *
 * Float32Array survives structured clone natively, so embeddings are stored
 * as-is with no base64 round trip.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Chunk, ChunkId, Conflict, Source, SourceId } from '@/src/types';
import { emitCorpusChange } from './bus';
import { PERSONAL } from './sessions';

const DB_NAME = 'autorag';
const DB_VERSION = 3;

interface AutoragDB extends DBSchema {
  sources: {
    key: SourceId;
    value: Source;
    indexes: { 'by-url': string };
  };
  chunks: {
    key: ChunkId;
    value: Chunk;
    indexes: { 'by-status': string; 'by-source': SourceId };
  };
  /**
   * Tombstones, and they are not bookkeeping — they are the difference between a
   * memory that forgets and one that only appears to.
   *
   * A deletion is the one change that leaves no trace to sync. Push the rows you
   * have and a forgotten source simply stays on the other device; pull them back
   * and it returns. Someone who deliberately removed something would watch it
   * reappear, which is worse than never having synced at all.
   */
  deletions: {
    key: string;
    /*
     * `sessionId` is on the tombstone for the same reason it is on the row: a
     * sync only ever touches one session, so a deletion that does not say which
     * session it belonged to would be pushed into whichever one happened to be
     * active — deleting a shared passage because someone forgot a private one.
     */
    value: { id: string; kind: 'source' | 'chunk'; at: string; sessionId?: string };
  };
}

let dbPromise: Promise<IDBPDatabase<AutoragDB>> | null = null;

function db(): Promise<IDBPDatabase<AutoragDB>> {
  if (!dbPromise) {
    dbPromise = openDB<AutoragDB>(DB_NAME, DB_VERSION, {
      upgrade(database, from, _to, tx) {
        if (from < 1) {
          const sources = database.createObjectStore('sources', { keyPath: 'id' });
          sources.createIndex('by-url', 'url');

          const chunks = database.createObjectStore('chunks', { keyPath: 'id' });
          chunks.createIndex('by-status', 'status');
          chunks.createIndex('by-source', 'sourceId');
        }
        // Added with cloud sync. Guarded by version rather than recreated, so an
        // existing corpus survives the upgrade instead of being rebuilt empty.
        if (from < 2) database.createObjectStore('deletions', { keyPath: 'id' });
        /*
         * v3: every row belongs to a session, so rows kept before sessions existed
         * join the personal one.
         *
         * Done here rather than lazily on read because the alternative is a corpus
         * where some rows answer the question and some do not, for as long as
         * nobody happens to touch them — and a sync scopes by session, so an
         * unmigrated row is simply invisible to every sync that runs. Migrating on
         * open means there is one moment where it is true, not a slow drift.
         */
        if (from > 0 && from < 3) {
          for (const name of ['sources', 'chunks', 'deletions'] as const) {
            const store = tx.objectStore(name);
            void store.openCursor().then(function stamp(cursor): unknown {
              if (!cursor) return undefined;
              const row = cursor.value as { sessionId?: string };
              if (!row.sessionId) cursor.update({ ...row, sessionId: PERSONAL } as never);
              return cursor.continue().then(stamp);
            });
          }
        }
      },
    });
  }
  return dbPromise;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

// ---------- sources ----------

export async function upsertSource(source: Source): Promise<void> {
  (await db()).put('sources', source);
}

export async function getSource(id: SourceId): Promise<Source | undefined> {
  return (await db()).get('sources', id);
}

export async function findSourceByUrl(url: string): Promise<Source | undefined> {
  return (await db()).getFromIndex('sources', 'by-url', url);
}

export async function allSources(): Promise<Source[]> {
  return (await db()).getAll('sources');
}

export async function setSourceStale(
  id: SourceId,
  stale: boolean,
  reason?: string,
): Promise<Source | undefined> {
  const database = await db();
  const source = await database.get('sources', id);
  if (!source) return undefined;
  const next: Source = { ...source, stale, staleReason: reason };
  await database.put('sources', next);
  emitCorpusChange();
  return next;
}

/**
 * Destructive: removes the source and every chunk belonging to it.
 *
 * Locally it is a real delete — the rows go. What survives is a tombstone, so a
 * sync can tell "this was removed" apart from "this device has not seen it yet".
 * Without that distinction the next pull would hand the source straight back.
 */
export async function deleteSourceCascade(id: SourceId): Promise<number> {
  const database = await db();
  const tx = database.transaction(['sources', 'chunks', 'deletions'], 'readwrite');
  const chunkIds = await tx.objectStore('chunks').index('by-source').getAllKeys(id);
  const at = new Date().toISOString();
  // Read the session off the row before it goes: after the delete there is
  // nothing left to ask, and a tombstone with no session syncs into the wrong one.
  const session = (await tx.objectStore('sources').get(id))?.sessionId;
  const stamp = session ? { sessionId: session } : {};
  for (const chunkId of chunkIds) {
    await tx.objectStore('chunks').delete(chunkId);
    await tx.objectStore('deletions').put({ id: chunkId, kind: 'chunk', at, ...stamp });
  }
  await tx.objectStore('sources').delete(id);
  await tx.objectStore('deletions').put({ id, kind: 'source', at, ...stamp });
  await tx.done;
  emitCorpusChange();
  return chunkIds.length;
}

/** Every deletion this device knows about, for the sync layer to propagate. */
export async function allDeletions(): Promise<
  { id: string; kind: 'source' | 'chunk'; at: string; sessionId?: string }[]
> {
  return (await db()).getAll('deletions');
}

/** Records a deletion observed from another device, and applies it here. */
export async function applyRemoteDeletion(
  id: string,
  kind: 'source' | 'chunk',
  at: string,
  sessionId?: string,
) {
  const database = await db();
  const tx = database.transaction(['sources', 'chunks', 'deletions'], 'readwrite');
  await tx.objectStore(kind === 'source' ? 'sources' : 'chunks').delete(id);
  await tx.objectStore('deletions').put({ id, kind, at, ...(sessionId ? { sessionId } : {}) });
  await tx.done;
}

// ---------- chunks ----------

export async function putChunks(chunks: Chunk[]): Promise<void> {
  const database = await db();
  const tx = database.transaction('chunks', 'readwrite');
  for (const chunk of chunks) tx.store.put(chunk);
  await tx.done;
}

export async function getChunk(id: ChunkId): Promise<Chunk | undefined> {
  return (await db()).get('chunks', id);
}

export async function chunksByStatus(status: Chunk['status']): Promise<Chunk[]> {
  return (await db()).getAllFromIndex('chunks', 'by-status', status);
}

export async function chunksBySource(sourceId: SourceId): Promise<Chunk[]> {
  return (await db()).getAllFromIndex('chunks', 'by-source', sourceId);
}

export async function allChunks(): Promise<Chunk[]> {
  return (await db()).getAll('chunks');
}

export async function countByStatus(): Promise<Record<Chunk['status'], number>> {
  const database = await db();
  const tx = database.transaction('chunks');
  const index = tx.store.index('by-status');
  const [pending, approved, rejected] = await Promise.all([
    index.count('pending'),
    index.count('approved'),
    index.count('rejected'),
  ]);
  await tx.done;
  return { pending, approved, rejected };
}

/**
 * Moves staged chunks to a terminal status. Returns the ids actually changed,
 * so a caller can tell the agent which ids were already decided.
 */
export async function decideChunks(
  ids: ChunkId[],
  status: 'approved' | 'rejected',
  rejectionReason?: string,
): Promise<ChunkId[]> {
  const database = await db();
  const tx = database.transaction('chunks', 'readwrite');
  const changed: ChunkId[] = [];
  for (const id of ids) {
    const chunk = await tx.store.get(id);
    if (!chunk) continue;
    /*
     * Which transitions are allowed, and why these:
     *
     *   pending  -> approved | rejected   the review decision
     *   approved -> rejected              you kept it, and later it stopped
     *                                     being worth keeping
     *   rejected -> anything              never: its text is what future
     *                                     screening matches against, so
     *                                     resurrecting it would quietly change
     *                                     what gets flagged
     *
     * Discarding something already approved used to be impossible — forgetting
     * the entire source was the only route, which threw away every other passage
     * from that page to remove one. Approving something twice is still a no-op.
     */
    const allowed =
      chunk.status === 'pending' || (chunk.status === 'approved' && status === 'rejected');
    if (!allowed) continue;
    tx.store.put({
      ...chunk,
      status,
      decidedAt: new Date().toISOString(),
      ...(rejectionReason ? { rejectionReason } : {}),
    });
    changed.push(id);
  }
  await tx.done;
  emitCorpusChange();
  return changed;
}

/**
 * Revises a staged passage before anyone decides on it.
 *
 * Only `pending` chunks are editable, and that is the whole safety property: an
 * approved passage is something a person already vouched for, and letting it change
 * underneath that decision would make approval meaningless. Rejected ones stay put
 * too, since their text is what future screening matches against.
 *
 * The caller supplies the new embedding rather than this module computing one. That
 * looks like a wart and is deliberate: `store.ts` has no model, and the alternative —
 * writing new text beside the old vector — would leave a passage that reads one way
 * and retrieves another. Passing them together makes the pairing impossible to
 * forget.
 */
export async function revisePendingChunk(
  id: ChunkId,
  patch: { text?: string; embedding?: Float32Array; note?: string; conflicts?: Conflict[] },
): Promise<Chunk | undefined> {
  if (patch.text !== undefined && !patch.embedding) {
    throw new Error('revisePendingChunk: new text must arrive with its new embedding.');
  }
  const database = await db();
  const chunk = await database.get('chunks', id);
  // Rejected passages stay put: their text is what future screening matches
  // against, so editing one would quietly change what gets flagged later.
  if (!chunk || chunk.status === 'rejected') return undefined;

  /*
   * Editing an approved passage returns it to the queue.
   *
   * Approval means a person read this and vouched for it. Letting the text change
   * underneath that decision would make approval meaningless — the corpus would
   * contain passages nobody had actually agreed to. But refusing outright was
   * worse in practice: you notice a bad passage precisely when it comes back in a
   * search, and being told "no" at that moment leaves you with forget-and-rekeep
   * as the only route.
   *
   * So the edit is allowed and the vouching is withdrawn. Re-approve it and you
   * have vouched for what it now says. Only a text change does this; adding a note
   * annotates without altering what was approved.
   */
  const reopened = chunk.status === 'approved' && patch.text !== undefined;

  const next: Chunk = {
    ...chunk,
    ...(reopened ? { status: 'pending' as const, decidedAt: undefined } : {}),
    ...(patch.text !== undefined ? { text: patch.text, embedding: patch.embedding! } : {}),
    ...(patch.conflicts !== undefined ? { conflicts: patch.conflicts } : {}),
    // An empty note clears it; undefined leaves whatever is there.
    ...(patch.note !== undefined ? (patch.note.trim() ? { note: patch.note.trim() } : {}) : {}),
  };
  if (patch.note !== undefined && !patch.note.trim()) delete next.note;

  await database.put('chunks', next);
  emitCorpusChange();
  return next;
}

/** Writes an agent's adjudication verdict onto a pending chunk's conflict. */
export async function annotateConflict(
  chunkId: ChunkId,
  againstChunkId: ChunkId,
  verdict: NonNullable<Conflict['agentVerdict']>,
): Promise<Chunk | undefined> {
  const database = await db();
  const chunk = await database.get('chunks', chunkId);
  if (!chunk) return undefined;
  const conflicts = chunk.conflicts.map((c) =>
    c.againstChunkId === againstChunkId ? { ...c, agentVerdict: verdict } : c,
  );
  const next = { ...chunk, conflicts };
  await database.put('chunks', next);
  emitCorpusChange();
  return next;
}

/** Test/demo affordance only — never exposed as a tool. */
export async function wipeAll(): Promise<void> {
  const database = await db();
  const tx = database.transaction(['sources', 'chunks', 'deletions'], 'readwrite');
  const at = new Date().toISOString();
  /*
   * Tombstone everything on the way out. A wipe that only cleared this device
   * would be undone by the next pull — the most alarming possible bug, since the
   * one thing a person doing this wants is for it to be gone everywhere.
   */
  // Each tombstone carries the session its row was in. A sync only touches one
  // session, so tombstones with no session would propagate the wipe to the
  // private corpus alone and leave every shared passage standing.
  for (const row of await tx.objectStore('sources').getAll()) {
    await tx
      .objectStore('deletions')
      .put({ id: row.id, kind: 'source', at, ...(row.sessionId ? { sessionId: row.sessionId } : {}) });
  }
  for (const row of await tx.objectStore('chunks').getAll()) {
    await tx
      .objectStore('deletions')
      .put({ id: row.id, kind: 'chunk', at, ...(row.sessionId ? { sessionId: row.sessionId } : {}) });
  }
  await tx.objectStore('sources').clear();
  await tx.objectStore('chunks').clear();
  await tx.done;
  emitCorpusChange();
}
