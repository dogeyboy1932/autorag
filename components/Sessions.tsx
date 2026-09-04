'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Panel } from '@/components/ui';
import { PERSONAL } from '@/src/rag/sessions';

/**
 * Which corpus you are keeping into, and who else is in it.
 *
 * ## Why this is one component used by two surfaces
 *
 * The panel and the web app must offer the same sessions, the same switcher and
 * the same warnings, and a second copy of this drifts within a week — one side
 * gains a confirmation the other lacks, and the two stop agreeing about what a
 * session is. Written once, rendered by both.
 *
 * They reach the engine by different routes, though: the panel messages an
 * offscreen document that owns the corpus, and the web app calls the engine in
 * its own page. So the *operations* are injected and only the interface is shared.
 * That is also what makes this testable without a browser extension.
 *
 * ## The header is not decoration
 *
 * It always names whose database you are writing to. Joining someone else's
 * session means every passage you approve lands in *their* project — the one
 * action here a person can take without noticing, and the only one they cannot
 * undo from their own machine.
 */

export interface SessionSummary {
  code: string;
  name: string;
  open_join?: boolean;
}

export interface SessionsApi {
  list(): Promise<SessionSummary[]>;
  create(name: string, openJoin: boolean): Promise<{ code: string; name: string }>;
  join(code: string): Promise<{ code: string; host: { url: string; anonKey: string; name: string } }>;
  invite(code: string, email: string): Promise<void>;
  /** Move to a session (or back to personal) and reconcile. Returns what arrived. */
  switchTo(session: { id: string; host?: { url: string; anonKey: string; name: string } } | null): Promise<{ pulled: number }>;
}

export default function Sessions({
  api,
  activeSessionId,
  hostedName,
  canHost,
  signedIn,
  onChanged,
}: {
  api: SessionsApi;
  activeSessionId: string;
  /** Set when the active session belongs to someone else. */
  hostedName?: string;
  /** Whether a Supabase project is attached — required to *host*, never to join. */
  canHost: boolean;
  signedIn: boolean;
  onChanged?: () => void;
}) {
  const [list, setList] = useState<SessionSummary[]>([]);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [invite, setInvite] = useState('');
  const [openJoin, setOpenJoin] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<React.ReactNode>(null);

  const active = activeSessionId || PERSONAL;
  const hosted = Boolean(hostedName);

  const refresh = useCallback(async () => {
    if (!signedIn) return;
    try {
      setList(await api.list());
    } catch {
      /* a directory that is down should not blank the switcher */
    }
  }, [api, signedIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!signedIn) {
    return (
      <Panel title="Sessions">
        <p style={note}>
          A session lets several people share one memory. Sign in to create one or join
          someone else&rsquo;s — an account is all it takes, no Supabase project.
        </p>
      </Panel>
    );
  }

  async function go(target: Parameters<SessionsApi['switchTo']>[0], label: string) {
    setBusy(label);
    setMsg(null);
    try {
      const { pulled } = await api.switchTo(target);
      setMsg(`Now in ${label} — ${pulled} passage(s) pulled.`);
      onChanged?.();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel
      title="Sessions"
      right={
        <span style={{ fontSize: 12, color: hosted ? 'var(--bad)' : 'var(--muted)' }}>
          {active === PERSONAL ? 'Personal — only you' : hosted ? `${hostedName} — someone else's` : active}
        </span>
      }
    >
      {hosted && (
        <p style={{ ...note, color: 'var(--bad)' }}>
          You are keeping into <strong>someone else&rsquo;s</strong> project. Everything you
          approve here is readable by everyone in this session.
        </p>
      )}

      <div style={row}>
        <Button
          disabled={active === PERSONAL || busy !== null}
          onClick={() => void go(null, 'Personal')}
        >
          {active === PERSONAL ? 'In your personal memory' : 'Back to personal'}
        </Button>
      </div>

      {list.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '10px 0', padding: 0, display: 'grid', gap: 4 }}>
          {list.map((x) => (
            <li key={x.code} style={item}>
              <span>
                {x.name} <code style={{ opacity: 0.6, fontSize: 11 }}>{x.code}</code>
              </span>
              <Button
                disabled={active === x.code || busy !== null}
                onClick={() => void go({ id: x.code }, x.name)}
              >
                {active === x.code ? 'current' : 'switch'}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div style={row}>
        <input
          placeholder="join by code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          style={field}
        />
        <Button
          disabled={!code.trim() || busy !== null}
          onClick={async () => {
            setBusy('joining');
            setMsg(null);
            try {
              const joined = await api.join(code.trim());
              setCode('');
              await go({ id: joined.code, host: joined.host }, joined.host.name || joined.code);
              void refresh();
            } catch (err) {
              setMsg(err instanceof Error ? err.message : String(err));
              setBusy(null);
            }
          }}
        >
          {busy === 'joining' ? '…' : 'Join'}
        </Button>
      </div>
      <p style={note}>Joining needs only an account. You do not need a Supabase project.</p>

      <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '12px 0' }} />

      {canHost ? (
        <>
          <div style={row}>
            <input
              placeholder="new session name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={field}
            />
            <Button
              tone="primary"
              disabled={!name.trim() || busy !== null}
              onClick={async () => {
                setBusy('creating');
                setMsg(null);
                try {
                  const made = await api.create(name.trim(), openJoin);
                  setName('');
                  setMsg(
                    <>
                      Created <strong>{made.name}</strong>, code <code>{made.code}</code>. Invite by
                      email rather than passing the code around — anyone holding a code can join.
                    </>,
                  );
                  void refresh();
                } catch (err) {
                  setMsg(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === 'creating' ? '…' : 'Create'}
            </Button>
          </div>

          {/*
            The one switch here that cannot quietly be taken back, so it is off by
            default and says what it does rather than being called "public".
          */}
          <label style={{ ...note, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={openJoin}
              onChange={(e) => setOpenJoin(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              Open to anyone — no invite needed. For a public demo corpus; anyone who finds the
              directory can read and change it.
            </span>
          </label>

          {active !== PERSONAL && !hosted && (
            <div style={{ ...row, marginTop: 8 }}>
              <input
                placeholder="invite an email address"
                value={invite}
                onChange={(e) => setInvite(e.target.value)}
                style={field}
              />
              <Button
                disabled={!invite.trim() || busy !== null}
                onClick={async () => {
                  setBusy('inviting');
                  setMsg(null);
                  try {
                    await api.invite(active, invite.trim());
                    setMsg(`Invited ${invite.trim()}.`);
                    setInvite('');
                  } catch (err) {
                    setMsg(err instanceof Error ? err.message : String(err));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === 'inviting' ? '…' : 'Invite'}
              </Button>
            </div>
          )}
        </>
      ) : (
        /*
         * Explained rather than hidden or disabled. A greyed-out Create with no
         * reason next to it reads as broken; the actual answer — that hosting is
         * the one thing needing a project of your own — is short and worth saying.
         */
        <p style={note}>
          To <strong>create</strong> a session you need your own Supabase project, because a
          shared corpus has to live in a database somebody owns. Attach one under Memory.
          Joining someone else&rsquo;s needs nothing.
        </p>
      )}

      <p style={note}>
        Everyone in a session reads every passage in it. An invite is safer than a code: a code
        is a bearer token, while an invite releases credentials only to the address you named.
      </p>
      {msg && <p style={note}>{msg}</p>}
    </Panel>
  );
}

const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 };
const field: React.CSSProperties = {
  flex: 1,
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--fg)',
  fontSize: 13,
};
const item: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '6px 8px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: 12,
};
const note: React.CSSProperties = { margin: '8px 0 0', fontSize: 12, color: 'var(--muted)' };
