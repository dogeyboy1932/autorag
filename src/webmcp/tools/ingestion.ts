/**
 * Ingestion tools. Contract: lib/tool-design/TOOL-CONTRACT.md.
 *
 * `execute` takes exactly one argument — verified at runtime on native Chrome
 * and the polyfill (lib/webmcp/API-DELTA.md D3). Do not add a second parameter.
 */

import type { ModelContextTool } from '@mcp-b/webmcp-types';
import { dryRun, ingestPassage } from '@/src/rag/ingest';
import { summarizeConflicts } from '@/src/rag/screen';
import { annotateConflict, allSources, chunksByStatus, decideChunks, getChunk } from '@/src/rag/store';
import { fail, guard } from '../errors';
import { syncToolGroups } from '../lifecycle';
import { page, preview, conflictOut } from './shared';

type Tool = ModelContextTool<never, unknown, string>;

export const ingestPassageTool = {
  name: 'autorag_ingest_passage',
  description:
    'Remember a passage you found while browsing. Chunks it, embeds it locally, screens it against what is already known, and stages it for human review. It does NOT become searchable until a human approves it, so tell the user it is awaiting review rather than implying it was saved.',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description:
          'The passage to remember, as plain text. Send the meaningful body only, with navigation, ads and cookie banners stripped. Between 50 and 20000 characters.',
      },
      source_url: {
        type: 'string',
        description:
          'Canonical URL the text came from. Used for provenance and deduplication, so prefer the permalink over a search or redirect URL.',
      },
      title: {
        type: 'string',
        description: 'Human-readable title of the source, shown to the person reviewing this passage.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional lowercase topic labels for later filtering, for example ["streaming","2026"].',
      },
      published_at: {
        type: 'string',
        description:
          'Optional ISO-8601 date the source was published. Supply it when the page states one: staleness detection is much weaker without it.',
      },
    },
    required: ['text', 'source_url', 'title'],
  },
  annotations: { readOnlyHint: false },
  execute: (input: {
    text: string;
    source_url: string;
    title: string;
    tags?: string[];
    published_at?: string;
  }) =>
    guard('autorag_ingest_passage', async () => {
      const text = (input.text ?? '').trim();
      if (text.length < 50) {
        return fail('INVALID_INPUT', 'Passage too short to be worth indexing (minimum 50 characters).');
      }
      if (text.length > 20000) {
        return fail('INVALID_INPUT', 'Passage exceeds 20000 characters. Split it and ingest in parts.', {
          received_length: text.length,
        });
      }
      if (!input.source_url?.trim() || !input.title?.trim()) {
        return fail('INVALID_INPUT', 'Both source_url and title are required for provenance.');
      }

      const result = await ingestPassage({
        text,
        sourceUrl: input.source_url.trim(),
        title: input.title.trim(),
        tags: input.tags,
        publishedAt: input.published_at,
      });

      // Staging just created a review queue; make the approval tools real before
      // telling the agent to poll them.
      await syncToolGroups();

      return {
        ok: true as const,
        source_id: result.sourceId,
        staged_chunk_ids: result.stagedChunkIds,
        chunk_count: result.chunkCount,
        conflicts: result.conflicts.map(conflictOut),
        conflict_summary: summarizeConflicts(result.conflicts),
        requires_human_approval: true,
        message:
          `Staged ${result.chunkCount} chunk(s) for human review. They are NOT searchable yet. ` +
          `${summarizeConflicts(result.conflicts)} Poll autorag_list_pending to see whether the human has decided.`,
      };
    }),
} satisfies Tool;

export const checkConflictsTool = {
  name: 'autorag_check_conflicts',
  description:
    'Dry run before ingesting. Screens a passage against the existing memory without saving anything, and tells you whether it is new, a duplicate, or contradicts something already known. Use this when you are unsure whether material is already remembered.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The candidate passage, as plain text.' },
      source_url: {
        type: 'string',
        description: 'Optional URL it came from; supplying it improves duplicate detection.',
      },
    },
    required: ['text'],
  },
  annotations: { readOnlyHint: true },
  execute: (input: { text: string; source_url?: string }) =>
    guard('autorag_check_conflicts', async () => {
      const text = (input.text ?? '').trim();
      if (text.length < 50) return fail('INVALID_INPUT', 'Passage too short to screen (minimum 50 characters).');

      const { wouldCreateChunks, conflicts } = await dryRun({
        text,
        sourceUrl: input.source_url?.trim() ?? '',
      });

      const hasDuplicate = conflicts.some((c) => c.kind === 'duplicate');
      const recommendation = hasDuplicate
        ? 'skip_duplicate'
        : conflicts.length > 0
          ? 'ingest_and_review'
          : 'ingest';

      return {
        ok: true as const,
        would_create_chunks: wouldCreateChunks,
        conflicts: conflicts.map(conflictOut),
        conflict_summary: summarizeConflicts(conflicts),
        recommendation,
      };
    }),
} satisfies Tool;

export const listPendingTool = {
  name: 'autorag_list_pending',
  description:
    'List passages staged and awaiting human review. Poll this after ingesting to find out whether the human approved or rejected your material. An empty list means everything you staged has been decided.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'How many to return. Default 20, maximum 100.' },
      offset: { type: 'number', description: 'Index to start from, for paging. Default 0.' },
      only_conflicted: {
        type: 'boolean',
        description: 'When true, return only staged chunks that were flagged during screening.',
      },
    },
  },
  annotations: { readOnlyHint: true },
  execute: (input: { limit?: number; offset?: number; only_conflicted?: boolean }) =>
    guard('autorag_list_pending', async () => {
      const [pending, sources] = await Promise.all([chunksByStatus('pending'), allSources()]);
      const byId = new Map(sources.map((s) => [s.id, s]));
      const filtered = input.only_conflicted ? pending.filter((c) => c.conflicts.length > 0) : pending;

      if (filtered.length === 0) {
        return fail('NOTHING_PENDING', 'The review queue is empty; nothing is awaiting human review.');
      }

      return {
        ok: true as const,
        ...page(filtered, input.limit, input.offset, (chunk) => ({
          chunk_id: chunk.id,
          text_preview: preview(chunk.text),
          source: {
            url: byId.get(chunk.sourceId)?.url,
            title: byId.get(chunk.sourceId)?.title,
          },
          conflicts: chunk.conflicts.map(conflictOut),
          staged_at: chunk.ingestedAt,
        })),
      };
    }),
} satisfies Tool;

export const approvePendingTool = {
  name: 'autorag_approve_pending',
  description:
    'Commit staged chunks into the searchable memory. Normally the human does this in the review queue UI; call it only when the person has explicitly told you to approve specific chunks in conversation.',
  inputSchema: {
    type: 'object',
    properties: {
      chunk_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Chunk ids to approve, as returned by autorag_list_pending.',
      },
    },
    required: ['chunk_ids'],
  },
  annotations: { readOnlyHint: false },
  execute: (input: { chunk_ids: string[] }) =>
    guard('autorag_approve_pending', async () => {
      if (!input.chunk_ids?.length) return fail('INVALID_INPUT', 'chunk_ids must be a non-empty array.');
      const changed = await decideChunks(input.chunk_ids, 'approved');
      await syncToolGroups();
      if (changed.length === 0) {
        return fail('NOT_FOUND', 'None of those chunk ids were pending. They may already have been decided.', {
          requested: input.chunk_ids,
        });
      }
      return {
        ok: true as const,
        approved_chunk_ids: changed,
        skipped: input.chunk_ids.filter((id) => !changed.includes(id)),
        message: `Approved ${changed.length} chunk(s); they are now searchable.`,
      };
    }),
} satisfies Tool;

export const rejectPendingTool = {
  name: 'autorag_reject_pending',
  description:
    'Discard staged chunks with a reason. The reason is kept and shown if similar material is proposed again, so write it for a future reader. Normally the human does this in the review queue UI.',
  inputSchema: {
    type: 'object',
    properties: {
      chunk_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Chunk ids to reject, as returned by autorag_list_pending.',
      },
      reason: {
        type: 'string',
        description:
          'Why this material is being rejected, in one sentence. Retained permanently and surfaced on future conflict checks.',
      },
    },
    required: ['chunk_ids', 'reason'],
  },
  annotations: { readOnlyHint: false },
  execute: (input: { chunk_ids: string[]; reason: string }) =>
    guard('autorag_reject_pending', async () => {
      if (!input.chunk_ids?.length) return fail('INVALID_INPUT', 'chunk_ids must be a non-empty array.');
      if (!input.reason?.trim()) {
        return fail('INVALID_INPUT', 'A reason is required; it is retained and shown on future conflicts.');
      }
      const changed = await decideChunks(input.chunk_ids, 'rejected', input.reason.trim());
      await syncToolGroups();
      if (changed.length === 0) {
        return fail('NOT_FOUND', 'None of those chunk ids were pending.', { requested: input.chunk_ids });
      }
      return { ok: true as const, rejected_chunk_ids: changed, reason: input.reason.trim() };
    }),
} satisfies Tool;

export const adjudicateConflictTool = {
  name: 'autorag_adjudicate_conflict',
  description:
    'Rule on a flagged pair of passages. Screening only nominates pairs by similarity and differing figures; it cannot tell whether they actually disagree. Read both passages and give a verdict, which is attached to the review queue for the human to see. Your verdict is advisory and approves nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      chunk_id: {
        type: 'string',
        description: 'The pending chunk that was flagged, from autorag_list_pending.',
      },
      against_chunk_id: {
        type: 'string',
        description: 'The already-approved chunk it was flagged against, from the conflict entry.',
      },
      ruling: {
        type: 'string',
        enum: ['keep_new', 'keep_existing', 'keep_both', 'unresolved'],
        description:
          'keep_new: the new passage supersedes the old one. keep_existing: the old one is still correct. keep_both: they do not actually conflict. unresolved: you cannot tell from the text alone.',
      },
      reasoning: {
        type: 'string',
        description:
          'One or two sentences a human will read while deciding. Cite the specific claims that conflict.',
      },
    },
    required: ['chunk_id', 'against_chunk_id', 'ruling', 'reasoning'],
  },
  annotations: { readOnlyHint: false },
  execute: (input: {
    chunk_id: string;
    against_chunk_id: string;
    ruling: 'keep_new' | 'keep_existing' | 'keep_both' | 'unresolved';
    reasoning: string;
  }) =>
    guard('autorag_adjudicate_conflict', async () => {
      if (!input.reasoning?.trim()) {
        return fail('INVALID_INPUT', 'reasoning is required; the human reads it while deciding.');
      }
      const target = await getChunk(input.chunk_id);
      if (!target) return fail('NOT_FOUND', `No chunk with id ${input.chunk_id}.`);

      const updated = await annotateConflict(input.chunk_id, input.against_chunk_id, {
        ruling: input.ruling,
        reasoning: input.reasoning.trim(),
        ruledAt: new Date().toISOString(),
      });
      if (!updated) return fail('NOT_FOUND', 'Could not attach the verdict to that chunk.');

      const matched = updated.conflicts.some((c) => c.againstChunkId === input.against_chunk_id);
      if (!matched) {
        return fail('NOT_FOUND', `Chunk ${input.chunk_id} has no recorded conflict against ${input.against_chunk_id}.`, {
          known_conflicts: updated.conflicts.map((c) => c.againstChunkId),
        });
      }

      return {
        ok: true as const,
        chunk_id: input.chunk_id,
        ruling: input.ruling,
        message: 'Verdict recorded on the review queue. The human still decides whether to approve.',
      };
    }),
} satisfies Tool;
