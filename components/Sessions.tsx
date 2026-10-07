'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Field, Fold } from '@/components/ui';
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
 * It always names whose corpus you are writing to. Joining someone else's session
 * means every passage you approve lands in *their* session, readable by everyone
 * in it — the one action here a person can take without noticing, and the only
 * one they cannot undo on their own.
 */

export interface SessionSummary {
  code: string;
  name: string;
  open_join?: boolean;
}

export interface SessionsApi {
  list(): Promise<SessionSummary[]>;
  create(name: string, openJoin: boolean): Promise<{ code: string; name: string }>;
  join(code: string): Promise<{ code: string; name: string }>;
  invite(code: string, email: string): Promise<void>;
  /** Move to a session (or back to personal) and reconcile. */
  switchTo(session: { id: string } | null): Promise<{ pulled: number }>;
}

export default function Sessions({
  api,
  activeSessionId,
  canCreate,
  signedIn,
  onChanged,
}: {
  api: SessionsApi;
  activeSessionId: string;
  /** A real account, not a demo one: only it can own a session. */
  canCreate: boolean;
  signedIn: boolean;
  onChanged?: () => void;
}) {
  const [list, setList] = useState<SessionSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [invite, setInvite] = useState('');
  const [openJoin, setOpenJoin] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<React.ReactNode>(null);

  const active = activeSessionId || PERSONAL;
  /*
   * Someone else's session: active, and not one this person owns. `list` returns
   * only owned sessions, so anything joined by code is absent from it. Until the
   * list has loaded this reads as not-hosted, rather than raising a false alarm.
   */
  const hosted = active !== PERSONAL && loaded && !list.some((x) => x.code === active);

  const refresh = useCallback(async () => {
    if (!signedIn) return;
    try {
      setList(await api.list());
      setLoaded(true);
    } catch {
      /* a directory that is down should not blank the switcher */
    }
  }, [api, signedIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!signedIn) {
    return (
      <Fold title="Sessions" status="signed out">
        <p className="note">
          A session lets several people share one memory. Sign in to create one or join
          someone else&rsquo;s — an account is all it takes.
        </p>
      </Fold>
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
    <Fold
      title="Sessions"
      status={active === PERSONAL ? 'personal' : hosted ? `${active} · shared` : (list.find((x) => x.code === active)?.name ?? active)}
    >
      {hosted && (
        <p className="note bad">
          You are keeping into <strong>someone else&rsquo;s</strong> session. Everything you
          approve here is readable by everyone in it.
        </p>
      )}

      <div className="session-list">
        <button
          className={active === PERSONAL ? 'session-row on' : 'session-row'}
          disabled={active === PERSONAL || busy !== null}
          onClick={() => void go(null, 'Personal')}
        >
          <span className="session-name">Personal</span>
          <span className="note">only you</span>
          <span className="session-cta">{active === PERSONAL ? 'current' : 'switch'}</span>
        </button>

        {list.map((x) => (
          <button
            key={x.code}
            className={active === x.code ? 'session-row on' : 'session-row'}
            disabled={active === x.code || busy !== null}
            onClick={() => void go({ id: x.code }, x.name)}
          >
            <span className="session-name">{x.name}</span>
            {/*
              The code is the one thing on this row you need to get *out* of the
              app — read aloud, pasted into a message. It sits inside a button,
              and a button's text is not selectable, so it could only be
              retyped from the screen. `stopPropagation` keeps a click that lands
              on it from switching sessions underneath the selection.
            */}
            <code
              className="pickable"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              title="Select to copy"
            >
              {x.code}
            </code>
            <span className="session-cta">{active === x.code ? 'current' : 'switch'}</span>
          </button>
        ))}
      </div>

      {/*
        Join by code, and the point of a code.
        
        An open session is already in the list above for anyone who can see it — so
        a code is for the sessions that are *not* listed: the private ones, where
        the code is the only way in. That is what makes it worth typing.
      */}
      <div className="row">
        <Field
          placeholder="join a private session by code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
        <Button
          disabled={!code.trim() || busy !== null}
          onClick={async () => {
            setBusy('joining');
            setMsg(null);
            try {
              const joined = await api.join(code.trim());
              setCode('');
              await go({ id: joined.code }, joined.name || joined.code);
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
      <p className="note">
        Joining needs only an account. A code is a bearer token: anyone holding it can join,
        which is exactly why it works for a session that is not listed.
      </p>

      <hr />

      {canCreate ? (
        <>
          <div className="row">
            <Field
              placeholder="new session name"
              value={name}
              onChange={(e) => setName(e.target.value)}
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
          <label className="check">
            <input
              type="checkbox"
              checked={openJoin}
              onChange={(e) => setOpenJoin(e.target.checked)}
            />
            <span className="note">
              Open to anyone — no invite needed. For a public demo corpus; anyone who finds the
              directory can read and change it.
            </span>
          </label>

          {active !== PERSONAL && !hosted && (
            <div className="row">
              <Field
                placeholder="invite an email address"
                value={invite}
                onChange={(e) => setInvite(e.target.value)}
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
         * Explained rather than hidden or disabled: a greyed-out Create with no
         * reason next to it reads as broken.
         */
        <p className="note">
          A demo account can join sessions but not create them — sign in with an email to
          make your own.
        </p>
      )}

      <p className="note">
        Everyone in a session reads every passage in it. An invite is safer than a code: a code
        is a bearer token, while an invite admits only the address you named.
      </p>
      {msg && <p className="note">{msg}</p>}
    </Fold>
  );
}
