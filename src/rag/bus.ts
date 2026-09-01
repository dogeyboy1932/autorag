/**
 * Corpus change notifications.
 *
 * The agent mutates the corpus through tool calls that never touch React. Without
 * this the review queue would sit stale while an agent fills it — which is exactly
 * the moment the demo needs to look alive.
 */

import { invalidateLexicalIndex } from './lexical';

type Listener = () => void;
const listeners = new Set<Listener>();

export function onCorpusChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitCorpusChange(): void {
  // The BM25 index is cached across searches; any corpus change invalidates it.
  invalidateLexicalIndex();
  for (const fn of listeners) fn();
}
