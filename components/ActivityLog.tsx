'use client';

import { useEffect, useState } from 'react';
import { onActivity, type ActivityEntry } from '@/src/webmcp/registry';
import { Empty, Panel, Pill } from './ui';

/**
 * Live feed of agent tool calls. Makes the agent's work visible while it
 * happens — without this, an agent filling the review queue looks like the page
 * changing on its own.
 */
export default function ActivityLog() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);

  useEffect(
    () =>
      onActivity((entry) => {
        // Registration noise would drown the calls that matter.
        if (entry.phase === 'registered') return;
        setEntries((prev) => [entry, ...prev].slice(0, 40));
      }),
    [],
  );

  const tone = (phase: ActivityEntry['phase']) =>
    phase === 'failed' ? 'bad' : phase === 'called' ? 'warn' : 'ok';

  return (
    <Panel title="Agent activity" right={<Pill tone="mute">{entries.length} events</Pill>}>
      {entries.length === 0 ? (
        <Empty>No agent calls yet. Every tool call an agent makes shows up here.</Empty>
      ) : (
        <div style={{ display: 'grid', gap: 4, maxHeight: 260, overflowY: 'auto' }}>
          {entries.map((e, i) => (
            <div
              key={i}
              style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}
            >
              <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                {new Date(e.at).toLocaleTimeString()}
              </span>
              <Pill tone={tone(e.phase)}>{e.phase}</Pill>
              <code style={{ color: 'var(--fg)' }}>{e.tool}</code>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
