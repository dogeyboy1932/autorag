/**
 * Structured errors. Every failure tells the agent what to do next.
 *
 * amendments.md A5.2: with analysis tools deferred, the quality of the remaining
 * surface is where this submission is won. A bare `throw new Error('not found')`
 * leaves the agent guessing; a suggested next tool lets it recover in one hop.
 */

export type ErrorCode =
  | 'EMPTY_CORPUS'
  | 'NOTHING_PENDING'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'DUPLICATE'
  | 'MODEL_NOT_READY'
  | 'INTERNAL';

export interface StructuredError {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    /** The tool the agent should try instead. Omitted only when nothing helps. */
    suggested_next_tool?: string;
    /** Extra machine-readable context, e.g. the ids that collided. */
    details?: Record<string, unknown>;
  };
}

const SUGGESTIONS: Record<ErrorCode, string | undefined> = {
  EMPTY_CORPUS: 'autorag_ingest_passage',
  NOTHING_PENDING: 'autorag_get_stats',
  NOT_FOUND: 'autorag_list_sources',
  INVALID_INPUT: undefined,
  DUPLICATE: 'autorag_check_conflicts',
  MODEL_NOT_READY: 'autorag_get_stats',
  INTERNAL: undefined,
};

export function fail(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  /**
   * Overrides the per-code default. Some failures have a better recovery than
   * their code implies — a refused deletion should point at `autorag_mark_stale`,
   * not at the generic INVALID_INPUT answer of "nothing helps". Naming the tool
   * in the prose is not enough: agents route on the field.
   */
  suggestedNextTool?: string,
): StructuredError {
  const suggestion = suggestedNextTool ?? SUGGESTIONS[code];
  return {
    ok: false,
    error: {
      code,
      message,
      ...(suggestion ? { suggested_next_tool: suggestion } : {}),
      ...(details ? { details } : {}),
    },
  };
}

/**
 * Wraps a tool body so an unexpected throw still reaches the agent as a
 * structured payload rather than an opaque transport-level rejection.
 */
export async function guard<T>(
  toolName: string,
  fn: () => Promise<T>,
): Promise<T | StructuredError> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[autorag] ${toolName} threw:`, err);
    return fail('INTERNAL', `${toolName} failed: ${message}`);
  }
}
