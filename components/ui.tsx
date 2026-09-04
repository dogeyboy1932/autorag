'use client';

import type { CSSProperties, ReactNode } from 'react';

/**
 * The shared furniture, as classes rather than inline styles.
 *
 * These were inline `style` objects, and the cost showed up everywhere: a button's
 * size was written into the component, so changing it meant finding every copy, and
 * there were about sixty stray `fontSize` literals across `components/` because
 * that was the only way to adjust anything. Inline styles also cannot express hover
 * or focus, so nothing had either.
 *
 * The classes live in `app/globals.css` next to the type scale they use.
 */

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
    <section className="panel" style={style}>
      <header className="panel-head">
        <h2>{title}</h2>
        {right}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

/**
 * A section that collapses, and says what it holds while collapsed.
 *
 * `status` is the whole reason this exists rather than a bare `<details>`: a column
 * of shut panels that report nothing is a filing cabinet you have to open one
 * drawer at a time. With it, `Answers — Opus 5` and `Sessions — personal` are
 * readable without a click.
 */
export function Fold({
  title,
  status,
  children,
  open,
  onToggle,
}: {
  title: string;
  status?: ReactNode;
  children: ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
}) {
  return (
    <details
      className="fold"
      {...(open === undefined ? {} : { open })}
      onToggle={(e) => onToggle?.(e.currentTarget.open)}
    >
      <summary>
        {title}
        {status !== undefined && <span className="soft">{status}</span>}
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

export function Button({
  children,
  onClick,
  tone = 'default',
  disabled,
  title,
  small,
  type,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  title?: string;
  small?: boolean;
  type?: 'button' | 'submit';
}) {
  const className = ['btn', tone === 'default' ? '' : tone, small ? 'small' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type ?? 'button'} className={className} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Note({ children, tone }: { children: ReactNode; tone?: 'bad' }) {
  return <p className={tone === 'bad' ? 'note bad' : 'note'}>{children}</p>;
}

export function Pill({
  children,
  tone,
}: {
  children: ReactNode;
  tone: 'ok' | 'warn' | 'bad' | 'mute' | 'solid';
}) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

/** A text input carrying the shared field treatment. */
export function Field(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return <input {...rest} className={className ? `field ${className}` : 'field'} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className, ...rest } = props;
  return <textarea {...rest} className={className ? `field ${className}` : 'field'} />;
}
