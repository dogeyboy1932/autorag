'use client';

import { useEffect, useState } from 'react';
import { Button, Panel } from '@/components/ui';
import {
  directoryConfigured,
  listOpenSessions,
  resolveSession,
  signInAnonymously,
  accountSignIn,
  accountSignUp,
} from '@/src/rag/directory';
import { syncNow } from '@/src/rag/sync';
import { countByStatus, wipeAll } from '@/src/rag/store';
import { PERSONAL } from '@/src/rag/sessions';

/**
 * The way in. Four of them, and none requires a Supabase project.
 *
 * ## The rule this screen exists to enforce
 *
 * An account is an email and a password. That is all. A Supabase project is a
 * *hosting* choice — you need one to keep your own corpus in the cloud, and you
 * need nothing at all to join someone else's session. Sign-in used to demand a
 * project URL and key before it would authenticate anything, which meant the
 * person this was built for could not get an account, and sessions could not be
 * tested by anyone.
 *
 * ## Why guest and demo are on the same screen as sign-in
 *
 * Someone landing here has no reason to trust the page yet. Making an account the
 * only way to see anything asks for a commitment before showing the thing being
 * committed to. Guest keeps everything local and says so; Demo borrows a real
 * corpus so the product can be judged in one click rather than described.
 */

export interface Account {
  email: string;
  demo?: boolean;
  guest?: boolean;
  directory?: { accessToken: string; refreshToken: string; userId: string };
  /**
   * The Supabase project this person hosts their own corpus in, if they have one.
   *
   * Absent for most people, and that is the normal case: you need a project to
   * *host* a corpus, never to sign in and never to join someone else's session.
   */
  project?: {
    url: string;
    anonKey: string;
    accessToken: string;
    refreshToken: string;
    userId: string;
  };
  sessionId?: string;
  host?: { url: string; anonKey: string; name: string };
}

/** The demo corpus, by name rather than by code. */
const DEMO_SESSION = 'public-demo';

export default function Auth({ onSignedIn }: { onSignedIn: (account: Account) => void }) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const configured = directoryConfigured();

  /*
   * Passages already in this browser, kept before anyone signed in.
   *
   * They need no migrating — they live in IndexedDB tagged `personal` and stay
   * there when you sign in, so a guest who makes an account keeps everything and
   * it syncs up the moment a project is attached. Worth saying out loud only so
   * nobody hesitates to sign up for fear of losing what they kept.
   *
   * Clearing is offered because someone may genuinely want a clean start, not as
   * a warning about anything.
   */
  const [kept, setKept] = useState<number | null>(null);
  useEffect(() => {
    void countByStatus()
      .then((c) => setKept(c.approved + c.pending))
      .catch(() => setKept(null));
  }, []);

  async function withAccount() {
    setBusy(mode === 'up' ? 'Creating your account…' : 'Signing in…');
    setMsg(null);
    try {
      // Does what the button says. Guessing past a person's stated intent is what
      // produced "User already registered" when the password was simply wrong.
      const account =
        mode === 'up'
          ? await accountSignUp(email.trim(), password)
          : await accountSignIn(email.trim(), password);
      onSignedIn({
        email: email.trim(),
        directory: {
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          userId: account.userId,
        },
      });
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function demo() {
    setBusy('Setting up the demo…');
    setMsg(null);
    try {
      const account = await signInAnonymously();
      const session = {
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        email: '',
        userId: account.userId,
      };

      /*
       * Found by name, not by a code compiled into the build. A code has to be
       * reissued whenever the demo corpus is rebuilt and is wrong-and-silent in
       * between — a stale one resolves to nothing and looks like a broken demo.
       */
      const open = await listOpenSessions(session);
      const demoSession = open.find((s) => s.name === DEMO_SESSION) ?? open[0];
      if (!demoSession) {
        setMsg('No demo corpus is published right now. You can still continue as a guest.');
        return;
      }

      setBusy(`Loading ${demoSession.name}…`);
      const creds = await resolveSession(demoSession.code, session);
      if (!creds) {
        setMsg('The demo corpus would not release its credentials.');
        return;
      }

      await syncNow(
        { url: creds.projectUrl, anonKey: creds.anonKey, sessionId: demoSession.code },
        { accessToken: creds.anonKey, refreshToken: '', email: '', userId: '' },
        (m) => setBusy(m),
      );

      onSignedIn({
        email: '',
        demo: true,
        directory: {
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          userId: account.userId,
        },
        sessionId: demoSession.code,
        host: { url: creds.projectUrl, anonKey: creds.anonKey, name: demoSession.name },
      });
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main style={{ maxWidth: 460, margin: '0 auto', padding: '64px 24px' }}>
      <h1 style={{ margin: 0, fontSize: 22, letterSpacing: -0.2 }}>Autorag</h1>
      <p style={{ color: 'var(--muted)', margin: '6px 0 20px', fontSize: 13 }}>
        A curated memory that lives in your browser. Keep things while you read, decide what
        stays, and get answers that cite the page each claim came from.
      </p>

      <Panel title={mode === 'in' ? 'Sign in' : 'Create an account'}>
        <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--muted)' }}>
          An email and a password. You do <strong>not</strong> need a Supabase project — that
          is only for hosting a corpus of your own, and you can add it later.
        </p>
        <div style={{ display: 'grid', gap: 8 }}>
          <input
            placeholder="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={field}
          />
          <input
            type="password"
            placeholder="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={field}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button
              tone="primary"
              disabled={!configured || !email.trim() || !password || busy !== null}
              onClick={() => void withAccount()}
            >
              {mode === 'in' ? 'Sign in' : 'Create account'}
            </Button>
            <button
              onClick={() => setMode(mode === 'in' ? 'up' : 'in')}
              style={linky}
              disabled={busy !== null}
            >
              {mode === 'in' ? 'or create one' : 'or sign in'}
            </button>
          </div>
        </div>
      </Panel>

      <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
        <Panel
          title="Just looking?"
          right={
            <Button tone="primary" onClick={() => void demo()} disabled={!configured || busy !== null}>
              Demo mode
            </Button>
          }
        >
          <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
            No signup. Borrows a real shared corpus so you can search it, review what is
            pending, and ask it questions. It is shared and writable — what you remove goes
            for the next visitor too.
          </p>
        </Panel>

        <Panel
          title="No account at all"
          right={
            <Button
              onClick={() => onSignedIn({ email: '', guest: true, sessionId: PERSONAL })}
              disabled={busy !== null}
            >
              Use as guest
            </Button>
          }
        >
          <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
            Everything stays in this browser. You can keep, review, search and ask — but not
            join sessions or sync anywhere, since both need an account. You can make one
            later and bring what you kept with you.
          </p>
        </Panel>
      </div>

      {kept !== null && kept > 0 && (
        <Panel
          title="Already in this browser"
          right={
            <Button
              tone="danger"
              disabled={busy !== null}
              onClick={async () => {
                await wipeAll();
                setKept(0);
              }}
            >
              Clear them
            </Button>
          }
        >
          <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
            {kept} passage{kept === 1 ? '' : 's'} already kept in this browser. Signing in keeps
            all of them — they come with you, and sync up once you attach a project. Clear them
            only if you want to start over.
          </p>
        </Panel>
      )}

      {busy && <p style={note}>{busy}</p>}
      {msg && <p style={{ ...note, color: 'var(--bad)' }}>{msg}</p>}
      {!configured && (
        <p style={{ ...note, color: 'var(--bad)' }}>
          This build has no directory configured, so accounts and demo mode are unavailable.
          Guest mode still works.
        </p>
      )}
    </main>
  );
}

const field: React.CSSProperties = {
  padding: '7px 9px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--fg)',
  fontSize: 13,
};

const linky: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--accent)',
  fontSize: 12,
  cursor: 'pointer',
  padding: 0,
};

const note: React.CSSProperties = { margin: '12px 0 0', fontSize: 12, color: 'var(--muted)' };
