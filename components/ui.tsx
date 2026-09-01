'use client';

import type { CSSProperties, ReactNode } from 'react';

export function Panel({
  title,
  right,
  children,
  style,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--panel)',
        overflow: 'hidden',
        ...style,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: 0.2 }}>{title}</h2>
        {right}
      </header>
      <div style={{ padding: 14 }}>{children}</div>
    </section>
  );
}

export function Button({
  children,
  onClick,
  tone = 'default',
  disabled,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  title?: string;
}) {
  const tones = {
    default: { bg: 'transparent', fg: 'var(--fg)', bd: 'var(--border)' },
    primary: { bg: 'rgba(68,147,248,.15)', fg: 'var(--accent)', bd: 'rgba(68,147,248,.4)' },
    danger: { bg: 'rgba(248,81,73,.12)', fg: 'var(--bad)', bd: 'rgba(248,81,73,.35)' },
  }[tone];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        background: tones.bg,
        color: tones.fg,
        border: `1px solid ${tones.bd}`,
        borderRadius: 6,
        padding: '5px 11px',
        font: 'inherit',
        fontSize: 12.5,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {children}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p style={{ color: 'var(--muted)', margin: 0, fontSize: 13 }}>{children}</p>;
}

export function Pill({ children, tone }: { children: ReactNode; tone: 'ok' | 'warn' | 'bad' | 'mute' }) {
  const color = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', mute: 'var(--muted)' }[tone];
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 11,
        color,
        border: `1px solid ${color}`,
        borderRadius: 999,
        padding: '1px 8px',
        opacity: 0.9,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}
