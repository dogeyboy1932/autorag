'use client';

import type { Conflict } from '@/src/types';
import { Pill } from './ui';

const TONE = {
  duplicate: 'bad',
  near_duplicate: 'warn',
  contradiction: 'warn',
  stale: 'mute',
} as const;

const LABEL = {
  duplicate: 'duplicate',
  near_duplicate: 'near-duplicate',
  contradiction: 'conflicting figures',
  stale: 'staleness',
} as const;

export default function ConflictBadge({ conflict }: { conflict: Conflict }) {
  const verdict = conflict.agentVerdict;
  // The stored detail ends with a "not yet judged" note written at screening
  // time. Once an agent has ruled, that sentence contradicts the verdict shown
  // right next to it, so drop it rather than rewriting history in the database.
  const detail = verdict
    ? conflict.detail.replace(/\s*Nominated for adjudication[^.]*\.\s*$/, '')
    : conflict.detail;
  return (
    <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Pill tone={TONE[conflict.kind]}>{LABEL[conflict.kind]}</Pill>
        {conflict.similarity !== undefined && (
          <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>
            similarity {conflict.similarity.toFixed(3)}
          </span>
        )}
        {verdict && <Pill tone="ok">agent: {verdict.ruling.replace('_', ' ')}</Pill>}
      </div>
      <span style={{ color: 'var(--muted)', fontSize: 12 }}>{detail}</span>
      {verdict && (
        <span style={{ color: 'var(--fg)', fontSize: 12, opacity: 0.85 }}>
          “{verdict.reasoning}”
        </span>
      )}
    </div>
  );
}
