/**
 * Retrieval: cosine similarity, filters, staleness demotion.
 *
 * Brute force over a plain array, per build plan AD-2. Under ~10k chunks a
 * linear scan of 384-float dot products is well under a frame; a vector DB here
 * would be complexity with no payoff.
 */

import type { Chunk, SearchHit, Source } from '@/src/types';
import { allChunks, allSources } from './store';
import { embedOne } from './embed';

/**
 * Multiplier applied to a chunk whose source is marked stale. Demote, don't
 * hide: `autorag_mark_stale` exists precisely so the record of what was once
 * believed stays in the corpus.
 */
export const STALE_PENALTY = 0.6;

/** Embeddings are L2-normalized at creation, so cosine is a plain dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export interface SearchOptions {
  k?: number;
  tags?: string[];
  includeStale?: boolean;
  /** Defaults to approved-only: pending material must never leak into retrieval. */
  status?: Chunk['status'];
}

export interface SearchResult {
  hits: SearchHit[];
  /** Ranked candidates just outside k, for `autorag_explain_retrieval`. */
  nearMisses: SearchHit[];
  totalCandidates: number;
}

/** Scores every candidate against an already-computed query vector. */
export function rankAgainst(
  queryVec: Float32Array,
  chunks: Chunk[],
  sources: Map<string, Source>,
  options: SearchOptions = {},
): SearchResult {
  const { k = 5, tags, includeStale = false, status = 'approved' } = options;

  const scored: SearchHit[] = [];
  for (const chunk of chunks) {
    if (chunk.status !== status) continue;
    const source = sources.get(chunk.sourceId);
    if (!source) continue;
    if (!includeStale && source.stale) continue;
    if (tags?.length && !tags.some((t) => source.tags.includes(t))) continue;

    const rawScore = cosine(queryVec, chunk.embedding);
    scored.push({
      chunk,
      source,
      rawScore,
      score: source.stale ? rawScore * STALE_PENALTY : rawScore,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return {
    hits: scored.slice(0, k),
    nearMisses: scored.slice(k, k + 3),
    totalCandidates: scored.length,
  };
}

export async function search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
  const [queryVec, chunks, sources] = await Promise.all([
    embedOne(query),
    allChunks(),
    allSources(),
  ]);
  return rankAgainst(queryVec, chunks, new Map(sources.map((s) => [s.id, s])), options);
}

/**
 * Confidence for `autorag_answer_with_sources`. Deliberately conservative:
 * the agent must be able to decline rather than confabulate, so a thin or
 * flat result set reports `low`.
 */
export function confidenceOf(hits: SearchHit[]): 'high' | 'medium' | 'low' {
  if (hits.length === 0) return 'low';
  const top = hits[0].score;
  if (top < 0.35) return 'low';
  if (top >= 0.6 && hits.length >= 2) return 'high';
  return 'medium';
}

export function coverageNote(hits: SearchHit[], totalCandidates: number): string {
  if (totalCandidates === 0) {
    return 'The corpus is empty or every source is filtered out. Nothing can be answered from memory yet.';
  }
  if (hits.length === 0) return 'No chunk scored above the retrieval floor for this question.';
  const top = hits[0].score;
  if (top < 0.35) {
    return 'Weak match. The corpus likely does not cover this question — say so rather than inferring an answer from these passages.';
  }
  if (hits.some((h) => h.source.stale)) {
    return 'At least one supporting source is marked stale; its ranking was demoted. Mention the age when citing it.';
  }
  return 'Supporting passages retrieved with provenance. Cite the sources listed.';
}
