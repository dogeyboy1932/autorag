'use client';

import { useCallback, useEffect, useState } from 'react';
import { countByStatus } from '@/src/rag/store';
import { useCorpusData } from '@/src/rag/hooks';
import { abortAll, getModelContext, registerGroup, whichSurface } from '@/src/webmcp/registry';
import { activeGroups, resetLifecycle, sweepRetired, syncToolGroups } from '@/src/webmcp/lifecycle';
import { alwaysTools, approvalTools, retrievalTools } from '@/src/webmcp/tools';
import { Pill } from './ui';

/**
 * Owns the WebMCP registration lifecycle.
 *
 * The state-dependent groups are synchronized by `syncToolGroups()`, which the
 * mutating tools also call directly — so the surface is correct the instant a
 * tool returns, not one React render later. This component only handles the
 * always-on group and mirrors the current state into the header.
 */
/**
 * Asks the browser what it is actually exposing, rather than counting what we
 * registered. The difference is the declarative `<form>` tool: the browser
 * derives it from markup, so it never passes through `registerGroup` and a
 * count of our own registrations reads one short of what an agent sees.
 */
async function countExposed(): Promise<number | null> {
  const ctx = getModelContext();
  if (!ctx?.getTools) return null;
  try {
    return (await ctx.getTools()).length;
  } catch {
    return null;
  }
}

export default function ToolRegistrar() {
  const [surface, setSurface] = useState<string>('none');
  const [groups, setGroups] = useState<string[]>([]);
  const [exposed, setExposed] = useState<number | null>(null);

  const load = useCallback(() => countByStatus(), []);
  const [counts] = useCorpusData(load, { pending: 0, approved: 0, rejected: 0 });

  // The polyfill installs document.modelContext as an import side effect, and is
  // a no-op when Chrome provides it natively.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await import('@mcp-b/global');
      if (cancelled) return;
      setSurface(whichSurface());
      await registerGroup('always', alwaysTools as never);
      await syncToolGroups();
      if (cancelled) return;
      setGroups(activeGroups());
      setExposed(await countExposed());
    })();
    return () => {
      cancelled = true;
      abortAll();
      resetLifecycle();
    };
  }, []);

  /*
   * Runs after any corpus change, from the UI or from a tool call that has
   * already returned. This is the only place groups are retracted — doing it
   * inside a tool would abort that tool's own in-flight execution.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await syncToolGroups();
      await sweepRetired();
      if (cancelled) return;
      setGroups(activeGroups());
      setExposed(await countExposed());
    })();
    return () => {
      cancelled = true;
    };
  }, [counts.pending, counts.approved]);

  // What we registered. Used only as a fallback: it cannot see the
  // form-derived tool, which the browser adds without going through us.
  const registeredCount =
    alwaysTools.length +
    (groups.includes('approval') ? approvalTools.length : 0) +
    (groups.includes('retrieval') ? retrievalTools.length : 0);
  const toolCount = exposed ?? registeredCount;

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {surface === 'none' ? (
        <Pill tone="bad">no WebMCP surface</Pill>
      ) : (
        <Pill tone="ok">
          {toolCount} tools on {surface}.modelContext
        </Pill>
      )}
    </div>
  );
}
