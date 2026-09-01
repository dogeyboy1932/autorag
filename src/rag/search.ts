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
import { bm25, contentTerms, isSelfContained, saturate, termCoverage, type LexDoc } from './lexical';

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
 * How strongly the retrieved passages match the query *as literally written*.
 *
 * This is a **signal, not a verdict.** Autorag has no LLM (build plan AD-1) and
 * cannot judge whether a question is answerable — only the calling agent can,
 * because only the agent has the conversation. "how long is it" is ambiguous to
 * this module and perfectly clear to an agent three turns into a discussion
 * about a film. Reporting `low` here means "these passages do not lexically
 * match what you sent me", never "give up".
 *
 * An absolute cosine cutoff was wrong and measurably so: similarity scales with
 * query length, so "runtime" scores 0.127 against the passage that literally
 * contains the runtime. Term coverage is the better signal at short lengths.
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

/**
 * Describes what was retrieved. **Reports facts; never issues instructions.**
 *
 * An earlier version of this said "the memory likely does not cover this — say so
 * rather than inferring an answer". That was the retrieval layer telling the
 * generation layer how to behave, on the basis of information it does not have.
 * The agent knows what "it" refers to; this module does not. So state the
 * signals and let the agent decide.
 */
export function coverageNote(
  hits: SearchHit[],
  totalCandidates: number,
  confidence: 'high' | 'medium' | 'low' = 'medium',
  unmatchedTerms: string[] = [],
  query = '',
): string {
  if (totalCandidates === 0) {
    return 'Nothing is searchable: the memory is empty, or every source was excluded by the filters.';
  }
  if (hits.length === 0) return 'No passage scored against this query.';

  const parts: string[] = [];
  const strength =
    confidence === 'high' ? 'strong' : confidence === 'medium' ? 'moderate' : 'weak';
  parts.push(`Lexical/semantic match to the query as written is ${strength}.`);

  if (query && !isSelfContained(query)) {
    parts.push(
      'This query refers to something it does not name, which only you can resolve — so the score above reflects wording, not whether the answer is here. Judge these passages on their content.',
    );
  } else if (unmatchedTerms.length > 0) {
    parts.push(
      `No passage contains ${unmatchedTerms
        .map((t) => `"${t}"`)
        .join(', ')} — the match rests on meaning rather than wording.`,
    );
  }

  if (hits.some((h) => h.source.stale)) {
    parts.push('A supporting source is marked stale and was demoted; note its age if you cite it.');
  }
  parts.push('Provenance for each passage is in `sources`.');
  return parts.join(' ');
}
