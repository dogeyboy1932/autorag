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

import type { Chunk, Conflict, ConflictKind, Source } from '@/src/types';
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
 * Two passages on the same subject that each carry figures the other does not are
 * the cheapest honest contradiction signal available offline. It over-nominates —
 * that is the intent, since the agent and the human both get a say afterwards.
 *
 * Note what this is and is not. It is a symmetric difference over numeric tokens:
 * a release year present in one passage and absent from the other lands here
 * exactly like two disagreeing review scores do. Deciding which of those is a
 * disagreement takes reading the sentences around the numbers, which is the
 * agent's job. So the two sides are reported separately and the wording says
 * "figures the other does not carry" rather than "the figures differ" — the
 * stronger claim is one this function is not in a position to make.
 */
function numericDisagreement(a: string, b: string): { inNew: string[]; inOther: string[] } | null {
  const [ta, tb] = [factualTokens(a), factualTokens(b)];
  if (ta.size === 0 || tb.size === 0) return null;
  const onlyA = [...ta].filter((t) => !tb.has(t));
  const onlyB = [...tb].filter((t) => !ta.has(t));
  if (onlyA.length === 0 || onlyB.length === 0) return null;
  return { inNew: onlyA.slice(0, 3), inOther: onlyB.slice(0, 3) };
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
 * Screens one incoming chunk against everything already in the store.
 *
 * All three statuses matter, for different reasons:
 *  - **approved** — the established corpus this passage might duplicate or contradict.
 *  - **pending** — material staged but not yet decided. Screening against it is
 *    essential: an agent typically harvests several sources in one burst, before
 *    the human has approved anything. Comparing only against approved chunks
 *    would mean a batch of four sources never gets cross-checked at all, and the
 *    contradiction between two of them would reach the queue unflagged.
 *  - **rejected** — so a source the human already turned down is flagged rather
 *    than silently re-proposed. The rejection reason is retained for exactly this.
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
          // The reason is a human's own sentence and already ends in punctuation;
          // only the bare form needs a period of its own.
          detail: chunk.rejectionReason
            ? `Closely matches material previously rejected: "${chunk.rejectionReason}"`
            : 'Closely matches material previously rejected.',
        });
      }
      continue;
    }
    const staged = chunk.status === 'pending';

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
      source.url !== input.source.url ? numericDisagreement(input.text, chunk.text) : null;

    if (differing) {
      conflicts.push({
        kind: 'contradiction',
        againstChunkId: chunk.id,
        similarity,
        detail:
          // Time-scoped on purpose: the detail is persisted with the chunk, and the
          // passage it names can be approved five seconds later. A bare "(also
          // awaiting review)" would then be a false statement sitting in the queue.
          `Same subject as ${source.title}${staged ? ' (itself awaiting review when this was screened)' : ''}, ` +
          `and each carries figures the other does not — this passage has ` +
          `${differing.inNew.join(', ')}; that one has ${differing.inOther.join(', ')}. ` +
          `Whether that is a disagreement takes reading the claims around the numbers. ` +
          `Nominated for adjudication — not yet judged.`,
      });
      continue;
    }

    if (similarity >= DUPLICATE_AT) {
      conflicts.push({
        kind: 'duplicate',
        againstChunkId: chunk.id,
        similarity,
        detail: staged
          ? `Identical to a passage from ${source.title} that was also awaiting review when this was screened.`
          : `Already in the corpus from ${source.title}.`,
      });
      continue;
    }

    if (similarity >= NEAR_DUPLICATE_AT) {
      conflicts.push({
        kind: 'near_duplicate',
        againstChunkId: chunk.id,
        similarity,
        detail: staged
          ? `Restates another passage awaiting review from ${source.title}.`
          : `Restates existing material from ${source.title}.`,
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

/** "1 near duplicate" / "3 near duplicates" — this string is read by people. */
function label(kind: ConflictKind, n: number): string {
  const singular = kind.replace('_', ' ');
  return n === 1 ? singular : `${singular}s`;
}

export function summarizeConflicts(conflicts: Conflict[]): string {
  if (conflicts.length === 0) return 'No conflicts detected.';
  const counts = conflicts.reduce<Record<string, number>>((acc, c) => {
    acc[c.kind] = (acc[c.kind] ?? 0) + 1;
    return acc;
  }, {});
  // Ends with a period because callers splice it into a longer message.
  return `${Object.entries(counts)
    .map(([kind, n]) => `${n} ${label(kind as ConflictKind, n)}`)
    .join(', ')}.`;
}
