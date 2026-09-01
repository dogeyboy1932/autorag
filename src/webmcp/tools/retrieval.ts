/**
 * Retrieval tools.
 *
 * Autorag has no LLM (build plan AD-1). These return passages plus provenance;
 * the calling agent writes the answer. That is the whole architecture, so the
 * descriptions say it explicitly — an agent that thinks this tool answers
 * questions will misreport what it got.
 */

import type { ModelContextTool } from '@mcp-b/webmcp-types';
import { confidenceOf, coverageNote, search } from '@/src/rag/search';
import { countByStatus } from '@/src/rag/store';
import { fail, guard } from '../errors';
import { page } from './shared';

type Tool = ModelContextTool<never, unknown, string>;

async function ensureCorpus() {
  const counts = await countByStatus();
  if (counts.approved === 0) {
    return fail(
      'EMPTY_CORPUS',
      counts.pending > 0
        ? `Nothing is approved yet, though ${counts.pending} chunk(s) are awaiting human review. Ask the person to review the queue.`
        : 'The memory is empty. Ingest something first.',
      { pending: counts.pending },
    );
  }
  return null;
}

export const searchTool = {
  name: 'autorag_search',
  description:
    'Semantic search over approved memory. Returns ranked passages with the source each came from. Only human-approved material is searchable; staged and rejected passages are never returned.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What to look for, in natural language. Full questions work better than keywords.',
      },
      k: { type: 'number', description: 'How many passages to return. Default 5, maximum 20.' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tag filter; only sources carrying at least one of these tags are considered.',
      },
      include_stale: {
        type: 'boolean',
        description:
          'When true, also return passages from sources marked stale. They stay demoted in ranking. Default false.',
      },
    },
    required: ['query'],
  },
  annotations: { readOnlyHint: true },
  execute: (input: { query: string; k?: number; tags?: string[]; include_stale?: boolean }) =>
    guard('autorag_search', async () => {
      if (!input.query?.trim()) return fail('INVALID_INPUT', 'query is required.');
      const empty = await ensureCorpus();
      if (empty) return empty;

      const k = Math.min(20, Math.max(1, Math.floor(input.k ?? 5)));
      const result = await search(input.query.trim(), {
        k,
        tags: input.tags,
        includeStale: input.include_stale,
      });

      /*
       * Zero candidates with a non-empty corpus means the filters ate
       * everything — almost always because every matching source is stale and
       * include_stale defaulted to false. Without saying so, an agent sees an
       * empty result and concludes the memory knows nothing.
       */
      const filteredOut = result.totalCandidates === 0;

      return {
        ok: true as const,
        query: input.query.trim(),
        ...(filteredOut
          ? {
              note:
                'No passages passed the filters. Sources marked stale are excluded unless include_stale is true; tag filters also apply. Retry with include_stale: true before concluding the memory lacks this.',
            }
          : {}),
        ...page(result.hits, k, 0, (hit) => ({
          chunk_id: hit.chunk.id,
          text: hit.chunk.text,
          score: Number(hit.score.toFixed(4)),
          source: {
            url: hit.source.url,
            title: hit.source.title,
            ingested_at: hit.source.ingestedAt,
            stale: hit.source.stale,
          },
        })),
        candidates_considered: result.totalCandidates,
      };
    }),
} satisfies Tool;

export const answerWithSourcesTool = {
  name: 'autorag_answer_with_sources',
  description:
    'Retrieve everything needed to answer a question from memory, with provenance. Returns supporting passages, the sources they came from with ingest dates, and a confidence signal. This tool does NOT write an answer — you do, from these passages, and you cite the sources. If confidence is low, say the memory does not cover the question instead of inferring an answer.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to answer from memory, in natural language.' },
      k: { type: 'number', description: 'How many supporting passages to retrieve. Default 6, maximum 20.' },
    },
    required: ['question'],
  },
  annotations: { readOnlyHint: true },
  execute: (input: { question: string; k?: number }) =>
    guard('autorag_answer_with_sources', async () => {
      if (!input.question?.trim()) return fail('INVALID_INPUT', 'question is required.');
      const empty = await ensureCorpus();
      if (empty) return empty;

      const k = Math.min(20, Math.max(1, Math.floor(input.k ?? 6)));
      const result = await search(input.question.trim(), { k });

      const sources = [...new Map(result.hits.map((h) => [h.source.id, h.source])).values()];

      return {
        ok: true as const,
        question: input.question.trim(),
        passages: result.hits.map((h) => ({
          chunk_id: h.chunk.id,
          text: h.chunk.text,
          score: Number(h.score.toFixed(4)),
          source_url: h.source.url,
        })),
        sources: sources.map((s) => ({
          url: s.url,
          title: s.title,
          ingested_at: s.ingestedAt,
          stale: s.stale,
          stale_reason: s.staleReason,
        })),
        confidence: confidenceOf(result.hits),
        coverage_note: coverageNote(result.hits, result.totalCandidates),
      };
    }),
} satisfies Tool;

export const explainRetrievalTool = {
  name: 'autorag_explain_retrieval',
  description:
    'Explain why a search returned what it did. Shows each candidate score, any staleness demotion applied, and the near-misses that placed just outside the cut. Use this when a retrieval looks wrong and you want to tell the human why.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The same query whose ranking you want explained.' },
      k: { type: 'number', description: 'Cut-off position to explain around. Default 5.' },
    },
    required: ['query'],
  },
  annotations: { readOnlyHint: true },
  execute: (input: { query: string; k?: number }) =>
    guard('autorag_explain_retrieval', async () => {
      if (!input.query?.trim()) return fail('INVALID_INPUT', 'query is required.');
      const empty = await ensureCorpus();
      if (empty) return empty;

      const k = Math.min(20, Math.max(1, Math.floor(input.k ?? 5)));
      const result = await search(input.query.trim(), { k, includeStale: true });

      const explain = (label: string) => (h: (typeof result.hits)[number]) => ({
        placement: label,
        chunk_id: h.chunk.id,
        source_title: h.source.title,
        raw_score: Number(h.rawScore.toFixed(4)),
        final_score: Number(h.score.toFixed(4)),
        staleness_demotion_applied: h.source.stale,
        text_preview: h.chunk.text.slice(0, 160),
      });

      return {
        ok: true as const,
        query: input.query.trim(),
        cutoff_k: k,
        returned: result.hits.map(explain('returned')),
        near_misses: result.nearMisses.map(explain('near_miss')),
        candidates_considered: result.totalCandidates,
        note:
          'Scores are cosine similarity over 384-dimensional all-MiniLM-L6-v2 embeddings. Sources marked stale have their score multiplied by 0.6.',
      };
    }),
} satisfies Tool;

/**
 * The one deferred analysis tool `amendments.md` A3 endorses, and only because
 * there is real computation behind it: retrieval plus an explicit score
 * threshold, reported honestly.
 *
 * Deliberately NOT called gap analysis. It answers "can this corpus support an
 * answer" — it cannot tell you what the corpus is missing, and the description
 * says so, because a thin wrapper over search sold as something bigger is worse
 * than not shipping it at all.
 */
export const checkCoverageTool = {
  name: 'autorag_check_coverage',
  description:
    'Ask whether the memory can support an answer to a question, before committing to answering it. Returns a verdict, the best supporting passages, and the top score. Use it to decide between answering from memory and going to browse for more material. It reports what the corpus DOES cover for this question; it cannot enumerate what is missing.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question you are considering answering from memory.' },
      threshold: {
        type: 'number',
        description:
          'Minimum cosine score to count as real support, between 0 and 1. Default 0.45. Raise it if you want only strong matches.',
      },
    },
    required: ['question'],
  },
  annotations: { readOnlyHint: true },
  execute: (input: { question: string; threshold?: number }) =>
    guard('autorag_check_coverage', async () => {
      if (!input.question?.trim()) return fail('INVALID_INPUT', 'question is required.');
      const empty = await ensureCorpus();
      if (empty) return empty;

      const threshold = Math.min(0.99, Math.max(0.01, input.threshold ?? 0.45));
      const result = await search(input.question.trim(), { k: 5 });
      const supporting = result.hits.filter((h) => h.score >= threshold);
      const top = result.hits[0]?.score ?? 0;

      const verdict =
        supporting.length >= 2 ? 'covered' : supporting.length === 1 ? 'partial' : 'not_covered';

      return {
        ok: true as const,
        question: input.question.trim(),
        verdict,
        threshold,
        top_score: Number(top.toFixed(4)),
        supporting_passages: supporting.map((h) => ({
          chunk_id: h.chunk.id,
          text: h.chunk.text,
          score: Number(h.score.toFixed(4)),
          source_url: h.source.url,
          source_title: h.source.title,
        })),
        candidates_considered: result.totalCandidates,
        recommendation:
          verdict === 'covered'
            ? 'Answer from memory with autorag_answer_with_sources and cite the sources.'
            : verdict === 'partial'
              ? 'Only one passage supports this. Answer cautiously and say the memory is thin here, or browse for a second source and ingest it.'
              : 'The memory does not cover this. Browse for material and ingest it with autorag_ingest_passage rather than guessing.',
      };
    }),
} satisfies Tool;
