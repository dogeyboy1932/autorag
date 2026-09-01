/**
 * Deterministic tool-group synchronization.
 *
 * Two hard constraints pull in opposite directions:
 *
 *  1. **Additions must be immediate.** An agent that calls
 *     `autorag_ingest_passage` and is told to poll `autorag_list_pending` will
 *     do so on its very next turn. If registration waited for a React render,
 *     the tool would not exist yet.
 *
 *  2. **Removals must NOT be immediate.** Aborting a group while one of its own
 *     tools is mid-execution destroys that call: Chrome rejects the pending
 *     `executeTool` with `UnknownError: The operation failed for an unknown
 *     transient reason`. `autorag_approve_pending` empties the queue and so
 *     retracts its own group — verified failing exactly this way. The agent sees
 *     an opaque exception even though the approval committed, and a retry then
 *     returns NOT_FOUND. That is the worst possible shape for an error.
 *
 * So: `syncToolGroups()` only ever registers. Retraction happens in
 * `sweepRetired()`, which `ToolRegistrar` calls from an effect once the call
 * that changed the state has already returned.
 */

import { countByStatus } from '@/src/rag/store';
import { abortGroup, registerGroup } from './registry';
import { approvalTools, retrievalTools } from './tools';

let approvalOn = false;
let retrievalOn = false;
let inFlight: Promise<void> | null = null;

async function addMissing(): Promise<void> {
  const counts = await countByStatus();

  // Take the flag from the return value, not from reaching the next line:
  // registration can decline (no model context) or be aborted mid-flight, and a
  // flag set optimistically would suppress the retry that should follow.
  if (counts.pending > 0 && !approvalOn) {
    approvalOn = await registerGroup('approval', approvalTools as never);
  }
  if (counts.approved > 0 && !retrievalOn) {
    retrievalOn = await registerGroup('retrieval', retrievalTools as never);
  }
}

/**
 * Registers any group the current corpus state calls for. Awaited by every
 * mutating tool before it returns. Never removes anything — see the note above.
 * Serialized so concurrent tool calls cannot interleave registrations.
 */
export function syncToolGroups(): Promise<void> {
  inFlight = (inFlight ?? Promise.resolve()).then(addMissing, addMissing);
  return inFlight;
}

/**
 * Retracts groups the corpus no longer justifies. Safe only when no tool from
 * those groups is executing, which is why it runs from a React effect rather
 * than from inside a tool.
 */
export async function sweepRetired(): Promise<void> {
  const counts = await countByStatus();

  if (counts.pending === 0 && approvalOn) {
    abortGroup('approval');
    approvalOn = false;
  }
  if (counts.approved === 0 && retrievalOn) {
    abortGroup('retrieval');
    retrievalOn = false;
  }
}

export function activeGroups(): string[] {
  return ['always', ...(approvalOn ? ['approval'] : []), ...(retrievalOn ? ['retrieval'] : [])];
}

/** Called on registry teardown so a remount starts from a clean slate. */
export function resetLifecycle(): void {
  approvalOn = false;
  retrievalOn = false;
  inFlight = null;
}
