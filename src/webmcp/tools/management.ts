/**
 * Corpus management tools.
 *
 * `autorag_forget_source` is the only destructive tool in the surface. Since
 * `requestUserInteraction` does not exist in any shipping runtime
 * (lib/webmcp/API-DELTA.md D4), its guard is an explicit `confirm` field plus
 * the UI's own confirmation — there is no browser-mediated consent step to lean on.
 */

import type { ModelContextTool } from '@mcp-b/webmcp-types';
import { EMBEDDING_DIM, EMBEDDING_MODEL, isReady } from '@/src/rag/embed';
import {
  allChunks,
  allSources,
  chunksBySource,
  countByStatus,
  deleteSourceCascade,
  getSource,
  setSourceStale,
} from '@/src/rag/store';
import { fail, guard } from '../errors';
import { syncToolGroups } from '../lifecycle';
import { page } from './shared';

type Tool = ModelContextTool<never, unknown, string>;

export const listSourcesTool = {
  name: 'autorag_list_sources',
  description:
    'List the sources in memory with their chunk counts, when they were ingested, and whether they are marked stale. Use this to see what the memory actually covers before searching it.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'How many to return. Default 20, maximum 100.' },
      offset: { type: 'number', description: 'Index to start from, for paging. Default 0.' },
      include_stale: {
        type: 'boolean',
        description: 'Include sources marked stale. Default true.',
      },
    },
  },
  annotations: { readOnlyHint: true },
  execute: (input: { limit?: number; offset?: number; include_stale?: boolean }) =>
    guard('autorag_list_sources', async () => {
      const [sources, chunks] = await Promise.all([allSources(), allChunks()]);
      const filtered = input.include_stale === false ? sources.filter((s) => !s.stale) : sources;

      if (filtered.length === 0) {
        return fail('EMPTY_CORPUS', 'No sources have been ingested yet.');
      }

      const counts = new Map<string, { approved: number; pending: number }>();
      for (const c of chunks) {
        const entry = counts.get(c.sourceId) ?? { approved: 0, pending: 0 };
        if (c.status === 'approved') entry.approved++;
        if (c.status === 'pending') entry.pending++;
        counts.set(c.sourceId, entry);
      }

      return {
        ok: true as const,
        ...page(filtered, input.limit, input.offset, (s) => ({
          source_id: s.id,
          url: s.url,
          title: s.title,
          ingested_at: s.ingestedAt,
          stale: s.stale,
          stale_reason: s.staleReason,
          tags: s.tags,
          approved_chunks: counts.get(s.id)?.approved ?? 0,
          pending_chunks: counts.get(s.id)?.pending ?? 0,
        })),
      };
    }),
} satisfies Tool;

export const getStatsTool = {
  name: 'autorag_get_stats',
  description:
    'Summarize the state of the memory: how many passages are approved, pending and rejected, how many sources, the date range, which embedding model is in use and its vector dimensions, and whether that model has finished loading. Cheap orientation call — use it first in a session to see whether there is anything worth searching.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
  execute: () =>
    guard('autorag_get_stats', async () => {
      const [counts, sources, chunks] = await Promise.all([countByStatus(), allSources(), allChunks()]);
      const dates = sources.map((s) => s.ingestedAt).sort();
      const conflictCount = chunks
        .filter((c) => c.status === 'pending')
        .reduce((n, c) => n + c.conflicts.length, 0);

      return {
        ok: true as const,
        chunk_count: chunks.length,
        approved: counts.approved,
        pending: counts.pending,
        rejected: counts.rejected,
        source_count: sources.length,
        stale_source_count: sources.filter((s) => s.stale).length,
        oldest_ingest: dates[0] ?? null,
        newest_ingest: dates[dates.length - 1] ?? null,
        conflict_count: conflictCount,
        embedding_model: EMBEDDING_MODEL,
        embedding_dimensions: EMBEDDING_DIM,
        model_ready: isReady(),
      };
    }),
} satisfies Tool;

export const markStaleTool = {
  name: 'autorag_mark_stale',
  description:
    'Flag a source as outdated without deleting it. Its passages stay searchable but are demoted in ranking and returned with a stale marker. Prefer this over forgetting a source: the record of what was once believed is part of the memory.',
  inputSchema: {
    type: 'object',
    properties: {
      source_id: { type: 'string', description: 'Source id from autorag_list_sources.' },
      reason: {
        type: 'string',
        description: 'Why it is outdated, in one sentence. Shown alongside the source from now on.',
      },
      stale: {
        type: 'boolean',
        description: 'Set false to clear an existing stale flag. Default true.',
      },
    },
    required: ['source_id', 'reason'],
  },
  annotations: { readOnlyHint: false },
  execute: (input: { source_id: string; reason: string; stale?: boolean }) =>
    guard('autorag_mark_stale', async () => {
      if (!input.reason?.trim()) return fail('INVALID_INPUT', 'A reason is required.');
      const updated = await setSourceStale(input.source_id, input.stale !== false, input.reason.trim());
      if (!updated) return fail('NOT_FOUND', `No source with id ${input.source_id}.`);
      return {
        ok: true as const,
        source_id: updated.id,
        title: updated.title,
        stale: updated.stale,
        reason: updated.staleReason,
      };
    }),
} satisfies Tool;

export const forgetSourceTool = {
  name: 'autorag_forget_source',
  description:
    'Permanently delete a source and every passage from it. This cannot be undone. Prefer autorag_mark_stale unless the person has explicitly asked for deletion. Requires confirm: true; calling it without confirm deletes nothing and comes back as an INVALID_INPUT error listing what would have been removed, so treat that error as the preview rather than a failure.',
  inputSchema: {
    type: 'object',
    properties: {
      source_id: { type: 'string', description: 'Source id from autorag_list_sources.' },
      confirm: {
        type: 'boolean',
        description:
          'Must be true to actually delete. Omit or set false to preview: nothing is deleted and the INVALID_INPUT error names the source and how many passages would go.',
      },
    },
    required: ['source_id'],
  },
  annotations: { readOnlyHint: false },
  execute: (input: { source_id: string; confirm?: boolean }) =>
    guard('autorag_forget_source', async () => {
      const source = await getSource(input.source_id);
      if (!source) return fail('NOT_FOUND', `No source with id ${input.source_id}.`);
      const chunks = await chunksBySource(input.source_id);

      if (input.confirm !== true) {
        return fail(
          'INVALID_INPUT',
          `Deletion requires confirm: true. This would permanently remove "${source.title}" and ${chunks.length} passage(s). Consider autorag_mark_stale instead.`,
          { source_id: source.id, title: source.title, chunks_that_would_be_deleted: chunks.length },
          'autorag_mark_stale',
        );
      }

      const removed = await deleteSourceCascade(input.source_id);
      // Forgetting the last source empties the corpus; retract retrieval tools.
      await syncToolGroups();
      return {
        ok: true as const,
        forgotten_source_id: input.source_id,
        title: source.title,
        chunks_removed: removed,
        message: `Permanently removed "${source.title}" and ${removed} passage(s).`,
      };
    }),
} satisfies Tool;
