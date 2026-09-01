/**
 * Ingestion orchestration: chunk → embed → screen → stage.
 *
 * Nothing here ever writes an `approved` chunk. Staging is the whole point:
 * the human decides what the memory becomes (`amendments.md` A1 — steering).
 */

import type { Chunk, Conflict, Source } from '@/src/types';
import { emitCorpusChange } from './bus';
import { chunkText } from './chunk';
import { embed } from './embed';
import { screenChunk, type Candidate } from './screen';
import {
  allChunks,
  allSources,
  findSourceByUrl,
  newId,
  putChunks,
  upsertSource,
} from './store';

export interface IngestInput {
  text: string;
  sourceUrl: string;
  title: string;
  tags?: string[];
  publishedAt?: string;
}

export interface IngestResult {
  sourceId: string;
  stagedChunkIds: string[];
  chunkCount: number;
  conflicts: Conflict[];
}

async function loadCandidates(): Promise<Candidate[]> {
  const [chunks, sources] = await Promise.all([allChunks(), allSources()]);
  const byId = new Map(sources.map((s) => [s.id, s]));
  return chunks
    .map((chunk) => ({ chunk, source: byId.get(chunk.sourceId) }))
    .filter((c): c is Candidate => Boolean(c.source));
}

/**
 * Screens a passage without persisting anything — backs `autorag_check_conflicts`.
 */
export async function dryRun(input: Pick<IngestInput, 'text' | 'sourceUrl'>): Promise<{
  wouldCreateChunks: number;
  conflicts: Conflict[];
}> {
  const pieces = chunkText(input.text);
  if (pieces.length === 0) return { wouldCreateChunks: 0, conflicts: [] };

  const [vectors, candidates] = await Promise.all([
    embed(pieces.map((p) => p.text)),
    loadCandidates(),
  ]);

  const now = new Date().toISOString();
  const conflicts = pieces.flatMap((piece, i) =>
    screenChunk(
      {
        text: piece.text,
        embedding: vectors[i],
        source: { url: input.sourceUrl, ingestedAt: now },
      },
      candidates,
    ),
  );
  return { wouldCreateChunks: pieces.length, conflicts };
}

export async function ingestPassage(input: IngestInput): Promise<IngestResult> {
  const pieces = chunkText(input.text);
  if (pieces.length === 0) {
    throw new Error('Passage produced no usable chunks after normalization.');
  }

  const [vectors, candidates] = await Promise.all([
    embed(pieces.map((p) => p.text)),
    loadCandidates(),
  ]);

  const now = new Date().toISOString();

  // Re-ingesting the same URL extends the existing source rather than forking it,
  // so provenance stays one-to-one with the page it came from.
  const existing = await findSourceByUrl(input.sourceUrl);
  const source: Source = existing ?? {
    id: newId('src'),
    url: input.sourceUrl,
    title: input.title,
    ingestedAt: now,
    stale: false,
    tags: input.tags ?? [],
  };
  if (existing && input.tags?.length) {
    source.tags = [...new Set([...source.tags, ...input.tags])];
  }
  await upsertSource(source);

  const allConflicts: Conflict[] = [];
  const chunks: Chunk[] = pieces.map((piece, i) => {
    const conflicts = screenChunk(
      {
        text: piece.text,
        embedding: vectors[i],
        source: { url: input.sourceUrl, ingestedAt: now, publishedAt: input.publishedAt },
      },
      candidates,
    );
    allConflicts.push(...conflicts);
    return {
      id: newId('chk'),
      sourceId: source.id,
      text: piece.text,
      ordinal: piece.ordinal,
      embedding: vectors[i],
      status: 'pending',
      conflicts,
      ingestedAt: now,
    };
  });

  await putChunks(chunks);
  emitCorpusChange();

  return {
    sourceId: source.id,
    stagedChunkIds: chunks.map((c) => c.id),
    chunkCount: chunks.length,
    conflicts: allConflicts,
  };
}
