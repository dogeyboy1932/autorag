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
        borderRadius: 14,
        background: 'var(--panel)',
        boxShadow: '0 10px 30px rgba(0, 0, 0, .12)',
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
          padding: '14px 16px',
          background: 'rgba(255, 255, 255, .018)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: 0.2 }}>{title}</h2>
        {right}
      </header>
      <div style={{ padding: 16 }}>{children}</div>
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
    default: { bg: 'rgba(255,255,255,.025)', fg: 'var(--fg)', bd: 'var(--border)' },
    primary: { bg: 'var(--accent)', fg: '#14200f', bd: 'var(--accent)' },
    danger: { bg: 'rgba(241,124,114,.12)', fg: 'var(--bad)', bd: 'rgba(241,124,114,.4)' },
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
        borderRadius: 8,
        padding: '7px 12px',
        fontWeight: 700,
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
