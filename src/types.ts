/** Core domain types for Autorag. See lib/tool-design/TOOL-CONTRACT.md. */

export type ChunkId = string;
export type SourceId = string;

/** Lifecycle of an ingested chunk. Nothing reaches `approved` without a human. */
export type ChunkStatus = 'pending' | 'approved' | 'rejected';

/** Why a chunk was flagged during screening. Drives the ReviewQueue badges. */
export type ConflictKind = 'duplicate' | 'near_duplicate' | 'contradiction' | 'stale';

export interface Conflict {
  kind: ConflictKind;
  /** The already-approved chunk this one collides with, if any. */
  againstChunkId?: ChunkId;
  /** 0..1 cosine similarity, present for duplicate/near_duplicate. */
  similarity?: number;
  /** Human-readable one-liner shown on the badge. */
  detail: string;
  /**
   * Set by `autorag_adjudicate_conflict` when the calling agent rules on a
   * flagged pair. The heuristic never writes this — it only nominates.
   */
  agentVerdict?: {
    ruling: 'keep_new' | 'keep_existing' | 'keep_both' | 'unresolved';
    reasoning: string;
    ruledAt: string;
  };
}

export interface Source {
  id: SourceId;
  url: string;
  title: string;
  ingestedAt: string;
  /** Marked by `autorag_mark_stale`; demotes every chunk of this source in ranking. */
  stale: boolean;
  staleReason?: string;
  tags: string[];
}

export interface Chunk {
  id: ChunkId;
  sourceId: SourceId;
  text: string;
  /** Position within the source document, for ordering and context reassembly. */
  ordinal: number;
  embedding: Float32Array;
  status: ChunkStatus;
  conflicts: Conflict[];
  ingestedAt: string;
  decidedAt?: string;
  /** Retained on rejection and surfaced in future conflict checks. */
  rejectionReason?: string;
}

/** A scored retrieval hit, always carrying provenance. */
export interface SearchHit {
  chunk: Chunk;
  source: Source;
  /** Fused relevance after any staleness demotion. This is what ranking uses. */
  score: number;
  /** Fused relevance before staleness demotion, for `autorag_explain_retrieval`. */
  rawScore: number;
  /** Cosine similarity alone — paraphrase signal. */
  denseScore: number;
  /** Saturated BM25 alone — exact-term signal. */
  lexicalScore: number;
}

/** Every list tool returns this envelope. */
export interface Page<T> {
  items: T[];
  has_more: boolean;
  next_offset: number | null;
  total_count: number;
}
