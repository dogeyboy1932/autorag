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

const DB_NAME = 'autorag';
const DB_VERSION = 1;

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
}

let dbPromise: Promise<IDBPDatabase<AutoragDB>> | null = null;

function db(): Promise<IDBPDatabase<AutoragDB>> {
  if (!dbPromise) {
    dbPromise = openDB<AutoragDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        const sources = database.createObjectStore('sources', { keyPath: 'id' });
        sources.createIndex('by-url', 'url');

        const chunks = database.createObjectStore('chunks', { keyPath: 'id' });
        chunks.createIndex('by-status', 'status');
        chunks.createIndex('by-source', 'sourceId');
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

/** Destructive: removes the source and every chunk belonging to it. */
export async function deleteSourceCascade(id: SourceId): Promise<number> {
  const database = await db();
  const tx = database.transaction(['sources', 'chunks'], 'readwrite');
  const chunkIds = await tx.objectStore('chunks').index('by-source').getAllKeys(id);
  for (const chunkId of chunkIds) await tx.objectStore('chunks').delete(chunkId);
  await tx.objectStore('sources').delete(id);
  await tx.done;
  emitCorpusChange();
  return chunkIds.length;
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
    if (!chunk || chunk.status !== 'pending') continue;
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
  const tx = database.transaction(['sources', 'chunks'], 'readwrite');
  await tx.objectStore('sources').clear();
  await tx.objectStore('chunks').clear();
  await tx.done;
}
