'use client';

import { useState } from 'react';
import { Button, Field, Fold, TextArea } from '@/components/ui';
import { useAccount } from '@/components/Shell';
import { publishProfile } from '@/src/rag/directory';
import { SCHEMA_SQL, signIn, signUp } from '@/src/rag/sync';

/**
 * Attach your own Supabase project, so a corpus of yours can live somewhere and be
 * shared.
 *
 * Optional, and separate from signing in. An account is an email and a password;
 * this is hosting. Most people never need it — you can keep, review, search, ask
 * and join other people's sessions without one.
 *
 * The password here is its own. It authenticates to a different database than the
 * account does, and tying them together means changing one silently breaks the
 * other.
 */
export default function AttachProject() {
  const [account, save] = useAccount();
  /*
   * Prefilled with the account email, and editable.
   *
   * The project's auth user is usually the same address as the account — most
   * people sign up for both with one email — but it does not have to be: the
   * project may predate the account, or belong to a work address. Prefilling saves
   * the common case from retyping; leaving it editable means the uncommon one is
   * not a dead end with no field to correct.
   */
  const [projectEmail, setProjectEmail] = useState(account?.email ?? '');
  const [url, setUrl] = useState('');
  const [anonKey, setAnonKey] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(true);
  const [copied, setCopied] = useState(false);

  if (!account?.directory) return null;

  if (account.project) {
    return (
      <Fold title="Host your own memory" status={new URL(account.project.url).host}>
        <p className="note">
          Hosting your corpus at <code>{new URL(account.project.url).host}</code>. Sessions you
          create live here.
        </p>
        <div className="row">
          <Button tone="danger" onClick={() => save({ ...account, project: undefined })}>
            Detach
          </Button>
        </div>
      </Fold>
    );
  }

  async function attach(create: boolean) {
    setBusy(create ? 'Creating…' : 'Connecting…');
    setMsg(null);
    try {
      const cfg = { url: url.trim(), anonKey: anonKey.trim() };
      const email = projectEmail.trim() || account!.email;
      const project = create
        ? await signUp(cfg, email, password)
        : await signIn(cfg, email, password);

      const dir = account!.directory!;
      /*
       * Published here rather than at sign-in, because this is the first moment
       * there is anything true to say. Without a profile row, a session this person
       * hosts resolves to nothing for everyone they hand the code to — and they
       * would have no way to see that from their own side.
       *
       * The profile records the *account* email, not whatever address the project
       * happens to be signed in under. Invites are matched against the account
       * email, so writing the project one here would make an invitation land on an
       * address the invitee never sees.
       */
      await publishProfile(
        { accessToken: dir.accessToken, refreshToken: dir.refreshToken, email: account!.email, userId: dir.userId },
        { userId: dir.userId, email: account!.email, cloud: cfg },
      );

      save({
        ...account!,
        project: {
          ...cfg,
          accessToken: project.accessToken,
          refreshToken: project.refreshToken,
          userId: project.userId,
        },
      });
      setMsg(null);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Fold title="Host your own memory" status="optional">
      <p className="note">
        Only needed to <strong>create</strong> a session, or to sync across devices. Joining
        someone else&rsquo;s session needs nothing at all. Your passages stay in a database you
        own — this app never sees it.
      </p>

      <details className="fold" open={showSql} onToggle={(e) => setShowSql(e.currentTarget.open)}>
        <summary>
          First-time setup <span className="soft">three steps</span>
        </summary>
        <div className="fold-body">
          <p className="note">
            <strong>1.</strong> In Supabase → SQL editor, run the script below.{' '}
            <strong>2.</strong> Authentication → Sign In / Providers → Email → turn off{' '}
            <strong>Confirm email</strong>; there is nowhere for a confirmation link to land.{' '}
            <strong>3.</strong> Use <em>Create</em> below with a password for the project — it
            does not have to match your account password.
          </p>
          <TextArea readOnly value={SCHEMA_SQL} rows={8} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 'var(--text-xs)' }} />
          <div className="row">
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(SCHEMA_SQL).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
            >
              {copied ? 'Copied' : 'Copy SQL'}
            </Button>
          </div>
        </div>
      </details>

      <Field placeholder="https://xxxx.supabase.co" value={url} onChange={(e) => setUrl(e.target.value)} />
      <Field
        placeholder="email for this project"
        value={projectEmail}
        onChange={(e) => setProjectEmail(e.target.value)}
      />
      <Field placeholder="publishable key" value={anonKey} onChange={(e) => setAnonKey(e.target.value)} />
      <Field
        type="password"
        placeholder="project password (its own)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <div className="row">
        <Button
          tone="primary"
          disabled={busy !== null || !url.trim() || !anonKey.trim() || !password || !projectEmail.trim()}
          onClick={() => void attach(true)}
        >
          {busy === 'Creating…' ? '…' : 'Create'}
        </Button>
        <Button
          disabled={busy !== null || !url.trim() || !anonKey.trim() || !password || !projectEmail.trim()}
          onClick={() => void attach(false)}
        >
          {busy === 'Connecting…' ? '…' : 'Connect'}
        </Button>
      </div>
      {msg && <p className="note bad">{msg}</p>}
    </Fold>
  );
}
