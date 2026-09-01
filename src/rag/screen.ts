/**
 * Screening: duplicates, contradiction candidates, staleness.
 *
 * This layer **nominates, it never rules** (plan D4). Embedding distance can tell
 * you two passages are about the same thing; it cannot tell you they disagree.
 * So the heuristic's job is to cheaply and deterministically shortlist pairs
 * worth a second look, and `autorag_adjudicate_conflict` hands that shortlist to
 * the calling agent for an actual verdict. The human sees both and decides.
 *
 * Being honest about that boundary matters: claiming embedding cosine "detects
 * contradictions" is the kind of overclaim `amendments.md` A3 warns against.
 */

import type { Chunk, Conflict, Source } from '@/src/types';
import { cosine } from './search';

/** At or above this, the passage is already in the corpus. */
export const DUPLICATE_AT = 0.97;
/** At or above this, it restates something known closely enough to review. */
export const NEAR_DUPLICATE_AT = 0.88;
/** Band where two passages are on the same subject but not saying the same thing. */
export const SAME_TOPIC_AT = 0.72;
/** A source this much older than its rival is a staleness signal. */
export const STALE_SKEW_DAYS = 180;

/**
 * Numbers, money, percentages, versions and years — what factual claims disagree
 * about. The decimal part is only matched when digits actually follow, so a
 * number ending a sentence yields "92" rather than "92.".
 */
const FACTUAL_TOKEN = /\$?\d[\d,]*(?:\.\d+)?%?/g;

function factualTokens(text: string): Set<string> {
  return new Set(text.match(FACTUAL_TOKEN) ?? []);
}

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

/**
 * Two passages on the same subject whose numeric claims differ are the cheapest
 * honest contradiction signal available offline. It over-nominates — that is the
 * intent, since the agent and the human both get a say afterwards.
 */
function numericDisagreement(a: string, b: string): string[] {
  const [ta, tb] = [factualTokens(a), factualTokens(b)];
  if (ta.size === 0 || tb.size === 0) return [];
  const onlyA = [...ta].filter((t) => !tb.has(t));
  const onlyB = [...tb].filter((t) => !ta.has(t));
  if (onlyA.length === 0 || onlyB.length === 0) return [];
  return [...onlyA.slice(0, 3), ...onlyB.slice(0, 3)];
}

export interface ScreenInput {
  text: string;
  embedding: Float32Array;
  source: Pick<Source, 'url' | 'ingestedAt'> & { publishedAt?: string };
}

export interface Candidate {
  chunk: Chunk;
  source: Source;
}

/**
 * Screens one incoming chunk against the approved corpus. Also consults
 * previously *rejected* chunks so a source the human already turned down is
 * flagged rather than silently re-proposed — the rejection reason is retained
 * for exactly this.
 */
export function screenChunk(input: ScreenInput, candidates: Candidate[]): Conflict[] {
  const conflicts: Conflict[] = [];

  for (const { chunk, source } of candidates) {
    const similarity = cosine(input.embedding, chunk.embedding);

    if (chunk.status === 'rejected') {
      if (similarity >= NEAR_DUPLICATE_AT) {
        conflicts.push({
          kind: 'duplicate',
          againstChunkId: chunk.id,
          similarity,
          detail: `Closely matches material previously rejected${
            chunk.rejectionReason ? `: "${chunk.rejectionReason}"` : ''
          }.`,
        });
      }
      continue;
    }
    if (chunk.status !== 'approved') continue;

    if (similarity < SAME_TOPIC_AT) continue;

    /*
     * Order matters, and the intuitive order is wrong.
     *
     * Two passages that contradict each other are *textually almost identical* —
     * "streaming on Max, 92 percent" vs "streaming on Netflix, 79 percent" scores
     * 0.93 cosine. Checking near-duplicate first therefore swallows every
     * contradiction before the contradiction check can run.
     *
     * So the differing-figures test goes first. The distinction it draws is the
     * one that actually matters: a near-duplicate *restates* known material, a
     * contradiction *disagrees* with it. Same similarity, opposite handling.
     */
    const differing =
      source.url !== input.source.url ? numericDisagreement(input.text, chunk.text) : [];

    if (differing.length > 0) {
      conflicts.push({
        kind: 'contradiction',
        againstChunkId: chunk.id,
        similarity,
        detail: `Same subject as ${source.title}, but the figures differ (${differing.join(
          ', ',
        )}). Nominated for adjudication — not yet judged.`,
      });
      continue;
    }

    if (similarity >= DUPLICATE_AT) {
      conflicts.push({
        kind: 'duplicate',
        againstChunkId: chunk.id,
        similarity,
        detail: `Already in the corpus from ${source.title}.`,
      });
      continue;
    }

    if (similarity >= NEAR_DUPLICATE_AT) {
      conflicts.push({
        kind: 'near_duplicate',
        againstChunkId: chunk.id,
        similarity,
        detail: `Restates existing material from ${source.title}.`,
      });
      continue;
    }

    if (source.url !== input.source.url) {
      const mine = input.source.publishedAt ?? input.source.ingestedAt;
      const theirs = source.ingestedAt;
      if (daysBetween(mine, theirs) >= STALE_SKEW_DAYS) {
        const incomingIsNewer = new Date(mine) > new Date(theirs);
        conflicts.push({
          kind: 'stale',
          againstChunkId: chunk.id,
          similarity,
          detail: incomingIsNewer
            ? `Covers the same ground as ${source.title}, which is over ${STALE_SKEW_DAYS} days older. Consider marking that source stale.`
            : `Older than existing material from ${source.title} on the same subject.`,
        });
      }
    }
  }

  // Strongest signal per rival chunk; a pair should produce one badge, not three.
  const rank: Record<Conflict['kind'], number> = {
    contradiction: 3,
    duplicate: 2,
    near_duplicate: 1,
    stale: 0,
  };
  const best = new Map<string, Conflict>();
  for (const c of conflicts) {
    const key = c.againstChunkId ?? c.detail;
    const existing = best.get(key);
    if (!existing || rank[c.kind] > rank[existing.kind]) best.set(key, c);
  }
  return [...best.values()];
}

export function summarizeConflicts(conflicts: Conflict[]): string {
  if (conflicts.length === 0) return 'No conflicts detected.';
  const counts = conflicts.reduce<Record<string, number>>((acc, c) => {
    acc[c.kind] = (acc[c.kind] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([kind, n]) => `${n} ${kind.replace('_', ' ')}`)
    .join(', ');
}
