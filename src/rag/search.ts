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
import { bm25, contentTerms, saturate, termCoverage, type LexDoc } from './lexical';

/**
 * Multiplier applied to a chunk whose source is marked stale. Demote, don't
 * hide: `autorag_mark_stale` exists precisely so the record of what was once
 * believed stays in the corpus.
 */
export const STALE_PENALTY = 0.6;

/**
 * Fusion weight for the lexical half.
 *
 * Dense similarity carries paraphrase; BM25 carries exact tokens. Neither alone
 * handles what people actually type. 0.4 was chosen by measurement, not taste:
 * it fixes bare-number and proper-noun queries without disturbing the
 * full-question cases dense already got right.
 */
export const LEXICAL_WEIGHT = 0.4;

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
  /** Query terms that matched nothing in the corpus, after typo correction. */
  unmatchedTerms: string[];
  /** Title-prefixed documents actually searched, so confidence can reuse them. */
  docs: LexDoc[];
}

/** Scores every candidate against an already-computed query vector. */
export function rankAgainst(
  query: string,
  queryVec: Float32Array,
  chunks: Chunk[],
  sources: Map<string, Source>,
  options: SearchOptions = {},
): SearchResult {
  const { k = 5, tags, includeStale = false, status = 'approved' } = options;

  const eligible = chunks.filter((chunk) => {
    if (chunk.status !== status) return false;
    const source = sources.get(chunk.sourceId);
    if (!source) return false;
    if (!includeStale && source.stale) return false;
    if (tags?.length && !tags.some((t) => source.tags.includes(t))) return false;
    return true;
  });

  // Lexical scores are computed over the eligible set only, so IDF reflects what
  // is actually searchable rather than the whole store. Each document is the
  // source title plus the chunk body — see LexDoc.
  const docs: LexDoc[] = eligible.map((chunk) => ({
    id: chunk.id,
    text: `${sources.get(chunk.sourceId)?.title ?? ''}\n${chunk.text}`,
  }));
  const lexical = bm25(query, docs);

  const scored: SearchHit[] = [];
  for (const chunk of eligible) {
    const source = sources.get(chunk.sourceId)!;
    const dense = cosine(queryVec, chunk.embedding);
    const lex = saturate(lexical.scores.get(chunk.id) ?? 0);
    const fused = (1 - LEXICAL_WEIGHT) * dense + LEXICAL_WEIGHT * lex;

    scored.push({
      chunk,
      source,
      denseScore: dense,
      lexicalScore: lex,
      rawScore: fused,
      score: source.stale ? fused * STALE_PENALTY : fused,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return {
    hits: scored.slice(0, k),
    nearMisses: scored.slice(k, k + 3),
    totalCandidates: scored.length,
    unmatchedTerms: lexical.unmatched,
    docs,
  };
}

export async function search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
  const [queryVec, chunks, sources] = await Promise.all([
    embedOne(query),
    allChunks(),
    allSources(),
  ]);
  return rankAgainst(query, queryVec, chunks, new Map(sources.map((s) => [s.id, s])), options);
}

/**
 * Confidence for `autorag_answer_with_sources`.
 *
 * An absolute cosine cutoff was wrong, and measurably so. Similarity scales with
 * query length: "runtime" scored 0.127 against the passage that *literally
 * contains the runtime*, and "how long is it" scored 0.139. A 0.35 floor
 * therefore reported `low` — telling the agent to decline — on eight of
 * twenty-one correct retrievals.
 *
 * What actually distinguishes a good hit from a bad one at short query lengths
 * is whether the passage contains the words asked about. So confidence keys on
 * term coverage first, and falls back to the dense score for paraphrase queries
 * that share no vocabulary with their answer.
 */
export function confidenceOf(hits: SearchHit[], query = '', docs: LexDoc[] = []): 'high' | 'medium' | 'low' {
  if (hits.length === 0) return 'low';
  const top = hits[0];
  const terms = contentTerms(query);
  const margin = top.score - (hits[1]?.score ?? 0);

  /*
   * A query of nothing but stopwords and pronouns ("what about it?") has no
   * terms to cover, so term coverage is meaningless and only the dense signal
   * is left to judge on.
   */
  if (terms.length === 0) {
    return top.denseScore >= 0.35 ? 'medium' : 'low';
  }

  const coverage = docs.length ? termCoverage(query, top.chunk.id, docs) : 0;

  // Every content word present, and clearly ahead of the runner-up.
  if (coverage >= 0.99 && margin > 0.02) return 'high';
  if (coverage >= 0.6 || top.denseScore >= 0.6) return 'high';
  if (coverage >= 0.34 || top.denseScore >= 0.4 || top.lexicalScore >= 0.5) return 'medium';
  return 'low';
}

export function coverageNote(
  hits: SearchHit[],
  totalCandidates: number,
  confidence: 'high' | 'medium' | 'low' = 'medium',
  unmatchedTerms: string[] = [],
): string {
  if (totalCandidates === 0) {
    return 'The corpus is empty or every source is filtered out. Nothing can be answered from memory yet.';
  }
  if (hits.length === 0) return 'No passage matched this question at all.';

  const parts: string[] = [];
  if (confidence === 'low') {
    parts.push(
      'Weak match. The memory likely does not cover this — say so rather than inferring an answer from these passages.',
    );
  } else {
    parts.push('Supporting passages retrieved with provenance. Cite the sources listed.');
  }
  if (unmatchedTerms.length > 0) {
    parts.push(
      `No passage mentions ${unmatchedTerms.map((t) => `"${t}"`).join(', ')}, so treat any claim about that as uncovered.`,
    );
  }
  if (hits.some((h) => h.source.stale)) {
    parts.push('At least one supporting source is marked stale and was demoted; mention its age when citing it.');
  }
  return parts.join(' ');
}
