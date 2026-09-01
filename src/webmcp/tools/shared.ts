/** Helpers shared by tool modules: pagination, previews, wire shapes. */

import type { Conflict } from '@/src/types';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** Every list tool returns this envelope — TOOL-CONTRACT rule 6. */
export function page<T, U>(
  all: T[],
  limit: number | undefined,
  offset: number | undefined,
  map: (item: T) => U,
): { items: U[]; has_more: boolean; next_offset: number | null; total_count: number } {
  const start = Math.max(0, Math.floor(offset ?? 0));
  const size = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT)));
  const slice = all.slice(start, start + size);
  const end = start + slice.length;
  return {
    items: slice.map(map),
    has_more: end < all.length,
    next_offset: end < all.length ? end : null,
    total_count: all.length,
  };
}

export function preview(text: string, max = 240): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** Conflicts cross the wire in snake_case, like every other tool payload. */
export function conflictOut(c: Conflict) {
  return {
    kind: c.kind,
    against_chunk_id: c.againstChunkId,
    similarity: c.similarity === undefined ? undefined : Number(c.similarity.toFixed(4)),
    detail: c.detail,
    agent_verdict: c.agentVerdict
      ? { ruling: c.agentVerdict.ruling, reasoning: c.agentVerdict.reasoning, ruled_at: c.agentVerdict.ruledAt }
      : undefined,
  };
}
