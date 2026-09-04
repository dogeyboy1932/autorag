/**
 * Ingestion orchestration: chunk → embed → screen → stage.
 *
 * Nothing here ever writes an `approved` chunk. Staging is the whole point:
 * the human decides what the memory becomes (`amendments.md` A1 — steering).
 */

import type { Chunk, Conflict, Source } from '@/src/types';
import { emitCorpusChange } from './bus';
import { chunkText } from './chunk';
import { embed, embedOne } from './embed';
import { screenChunk, type Candidate } from './screen';
import {
  allChunks,
  allSources,
  findSourceByUrl,
  getActiveSession,
  getChunk,
  getSource,
  newId,
  putChunks,
  revisePendingChunk,
  upsertSource,
} from './store';
import { sessionOf } from './sessions';
import { setActiveSession } from './store';

export interface IngestInput {
  text: string;
  sourceUrl: string;
  title: string;
  tags?: string[];
  publishedAt?: string;
  /** Which session this is kept into. Absent means the personal one. */
  sessionId?: string;
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
  if (input.sessionId !== undefined) setActiveSession(input.sessionId);
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
  const session = input.sessionId === undefined ? getActiveSession() : sessionOf(input.sessionId);
  const existing = await findSourceByUrl(input.sourceUrl);
  const source: Source = existing ?? {
    id: newId('src'),
    url: input.sourceUrl,
    title: input.title,
    ingestedAt: now,
    stale: false,
    tags: input.tags ?? [],
    sessionId: session,
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
      /*
       * The chunk follows its source, not the active session. Re-ingesting a URL
       * extends the existing source, so a passage added later would otherwise land
       * in whatever session happened to be open and be split from the rest of the
       * page it came from — with half of it shared and half of it not.
       */
      sessionId: source.sessionId ?? session,
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

/**
 * Revising a passage that is already in the corpus — a typo, a paragraph that
 * dragged in a cookie banner, or a note about why it is worth keeping.
 *
 * ## Why this lives here and not at the two call sites
 *
 * Both surfaces let you fix a passage at the moment you notice it is wrong, which
 * is almost always when it comes back in a search rather than while it sits in the
 * review queue. The panel routes that through the offscreen document and the web
 * app calls it in the page, but the *work* is identical and subtle enough that two
 * copies would have drifted: changed text has to be re-embedded and re-screened,
 * not merely stored.
 *
 * Re-embedding is not optional. Writing new text beside the old vector leaves a
 * passage that reads one way and retrieves another, and nothing surfaces that until
 * a search quietly stops finding something. Re-screening is the same argument
 * applied to conflicts: the previous verdict was about text that is no longer
 * there.
 *
 * The note is deliberately *not* embedded. It is a person's annotation about the
 * passage, and folding it into the indexed text would let a remark about a passage
 * compete with the passage itself in search results.
 */
export async function revisePassage(
  chunkId: string,
  patch: { text?: string; note?: string },
): Promise<Chunk> {
  const before = await getChunk(chunkId);
  if (!before) throw new Error(`No passage with id ${chunkId}.`);
  if (before.status === 'rejected') {
    throw new Error(
      'A discarded passage cannot be edited — its text is what future screening matches against.',
    );
  }

  const text = patch.text?.trim();
  if (text !== undefined && text.length < 50) {
    throw new Error(`A passage needs at least 50 characters; that one has ${text.length}.`);
  }

  let embedding: Float32Array | undefined;
  let conflicts: Conflict[] | undefined;
  if (text !== undefined && text !== before.text) {
    embedding = await embedOne(text);
    const source = await getSource(before.sourceId);
    if (source) {
      const [chunks, sources] = await Promise.all([allChunks(), allSources()]);
      const byId = new Map(sources.map((x) => [x.id, x]));
      const candidates = chunks
        // Never screen a passage against itself; it would flag as a duplicate of
        // the very thing being edited.
        .filter((c) => c.id !== before.id)
        .map((chunk) => ({ chunk, source: byId.get(chunk.sourceId) }))
        .filter((c): c is Candidate => Boolean(c.source));
      conflicts = screenChunk({ text, embedding, source }, candidates);
    }
  }

  const updated = await revisePendingChunk(chunkId, {
    ...(text !== undefined ? { text, embedding } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    ...(conflicts !== undefined ? { conflicts } : {}),
  });
  if (!updated) throw new Error('That passage is no longer editable.');
  return updated;
}
