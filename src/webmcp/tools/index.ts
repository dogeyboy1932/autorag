/**
 * Tool groups and their registration conditions (TOOL-CONTRACT, final section).
 *
 * Dynamic registration keeps the surface honest: an agent is never offered
 * `autorag_search` against an empty index, nor approval tools with nothing to
 * approve. Groups are added and removed with AbortController, because
 * `unregisterTool` no longer exists (API-DELTA D2).
 */

import {
  adjudicateConflictTool,
  approvePendingTool,
  checkConflictsTool,
  ingestPassageTool,
  listPendingTool,
  rejectPendingTool,
} from './ingestion';
import {
  answerWithSourcesTool,
  checkCoverageTool,
  explainRetrievalTool,
  searchTool,
} from './retrieval';
import { forgetSourceTool, getStatsTool, listSourcesTool, markStaleTool } from './management';

/** Always available: you can always deposit, screen, and orient. */
export const alwaysTools = [
  ingestPassageTool,
  checkConflictsTool,
  getStatsTool,
  listSourcesTool,
];

/** Only while something is staged. */
export const approvalTools = [
  listPendingTool,
  approvePendingTool,
  rejectPendingTool,
  adjudicateConflictTool,
];

/** Only while the approved corpus is non-empty. */
export const retrievalTools = [
  searchTool,
  answerWithSourcesTool,
  explainRetrievalTool,
  checkCoverageTool,
  markStaleTool,
  forgetSourceTool,
];

export const ALL_TOOL_NAMES = [...alwaysTools, ...approvalTools, ...retrievalTools].map(
  (t) => t.name,
);
