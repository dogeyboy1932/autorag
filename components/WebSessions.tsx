'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Sessions, { type SessionsApi } from '@/components/Sessions';
import { useAccount } from '@/components/Shell';
import {
  inviteToSession,
  listSessions,
  publishSession,
  resolveSession,
} from '@/src/rag/directory';
import { createLocalSession, PERSONAL } from '@/src/rag/sessions';
import { refresh as refreshCloud, syncNow } from '@/src/rag/sync';
import { setActiveSession } from '@/src/rag/store';
import { emitCorpusChange, onCorpusChange } from '@/src/rag/bus';
import { Button } from '@/components/ui';
import type { Account } from '@/components/Auth';

async function syncAccount(
  account: Account,
  save: (next: Account) => void,
): Promise<{ pulled: number }> {
  const host = account.host;
  const project = account.project;
  const sessionId = account.sessionId ?? PERSONAL;
  const cloud = host
    ? { url: host.url, anonKey: host.anonKey, sessionId }
    : project && { url: project.url, anonKey: project.anonKey, sessionId };
  if (!cloud) throw new Error('Attach a project or join a session before syncing.');

  const auth = host
    ? { accessToken: host.anonKey, refreshToken: '', email: '', userId: '' }
    : {
        accessToken: project!.accessToken,
        refreshToken: project!.refreshToken,
        email: account.email,
        userId: project!.userId,
      };

  try {
    const result = await syncNow(cloud, auth);
    return { pulled: result.pulled };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (host || !/jwt|expired|invalid token|401/i.test(detail)) throw err;

    const renewed = await refreshCloud(cloud, auth);
    save({
      ...account,
      project: { ...project!, accessToken: renewed.accessToken, refreshToken: renewed.refreshToken },
    });
    const result = await syncNow(cloud, renewed);
    return { pulled: result.pulled };
  }
}

/**
 * The web app's half of the session UI: the shared component plus the operations
 * it needs, run directly in this page.
 *
 * The panel reaches the engine by messaging an offscreen document that owns the
 * corpus. Here there is no such indirection — the engine runs in this tab — so
 * these are plain calls. That difference is the entire reason `Sessions` takes an
 * injected API rather than assuming one route.
 */
export default function WebSessions({ onChanged }: { onChanged?: () => void }) {
  const [account, save] = useAccount();
  const syncing = useRef(false);

  const api: SessionsApi = useMemo(() => {
    const dir = account?.directory;
    const session = dir && {
      accessToken: dir.accessToken,
      refreshToken: dir.refreshToken,
      email: account?.email ?? '',
      userId: dir.userId,
    };

    const need = () => {
      if (!session) throw new Error('Sign in first.');
      return session;
    };

    return {
      list: async () => (session && !account?.demo ? await listSessions(session) : []),

      create: async (name, openJoin) => {
        const s = need();
        const project = account?.project;
        if (!project) throw new Error('Attach your own Supabase project first — a session lives in one.');

        /*
         * Read aloud and typed by hand, so no 0/O or 1/I. A code that cannot be
         * dictated over a call is not shareable, which is the only thing it is for.
         */
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const code = Array.from(
          crypto.getRandomValues(new Uint8Array(8)),
          (n) => alphabet[n % alphabet.length],
        ).join('');

        /*
         * The corpus row first. It is what actually authorises reads — every policy
         * in the owner's project consults `shared` here — while the directory only
         * records that a code exists. Published first, a failure here left a
         * joinable code pointing at a project with no matching session, so members
         * saw an empty corpus and the owner saw nothing wrong at all.
         */
        await createLocalSession(
          { url: project.url, anonKey: project.anonKey },
          {
            accessToken: project.accessToken,
            refreshToken: project.refreshToken,
            email: account?.email ?? '',
            userId: project.userId,
          },
          { id: code, name, shared: true },
        );
        await publishSession(s, { code, name, openJoin, ownerUserId: s.userId });
        return { code, name };
      },

      join: async (code) => {
        const s = need();
        const resolved = await resolveSession(code.toUpperCase(), s);
        /*
         * One message for "no such code" and for "not yours to join". credentials_for
         * deliberately does not distinguish them, because telling them apart makes
         * this an oracle for which codes are real.
         */
        if (!resolved) {
          throw new Error(
            'No session with that code, or you have not been invited to it. Ask the owner to invite your email address.',
          );
        }
        return {
          code: code.toUpperCase(),
          host: { url: resolved.projectUrl, anonKey: resolved.anonKey, name: code.toUpperCase() },
        };
      },

      invite: async (code, email) => {
        await inviteToSession(need(), code, email);
      },

      switchTo: async (target) => {
        const project = account?.project;

        /*
         * Work out where this session actually lives before syncing it.
         *
         * A session picked from the switcher is only a code, and the list mixes
         * sessions this person hosts with sessions they were invited to. Assuming
         * the local project was the bug: switching to somebody else's session
         * queried *your* database for their session id, found nothing, and showed
         * an empty corpus with no error — which is exactly what "I joined and
         * cannot see it" looks like.
         *
         * Having a project of your own does not make a joined session yours. The
         * directory is the only thing that knows the difference, so it is asked,
         * unless the caller already looked it up (the join path).
         */
        let host = target?.host;
        if (target && !host && session) {
          const resolved = await resolveSession(target.id, session);
          if (resolved && resolved.projectUrl.replace(/\/$/, '') !== project?.url.replace(/\/$/, '')) {
            host = { url: resolved.projectUrl, anonKey: resolved.anonKey, name: target.id };
          }
        }

        const next = { ...account!, sessionId: target?.id ?? PERSONAL, host };
        setActiveSession(next.sessionId);
        save(next);

        /*
         * A member reaches the host's project as the anon role, holding the key the
         * session was shared with and signed in as nobody — which is exactly what a
         * member is. Own sessions use the attached project instead.
         */
        const cloud = host
          ? { url: host.url, anonKey: host.anonKey, sessionId: target!.id }
          : project && { url: project.url, anonKey: project.anonKey, sessionId: next.sessionId };
        if (!cloud) return { pulled: 0 };

        const auth = host
          ? { accessToken: host.anonKey, refreshToken: '', email: '', userId: '' }
          : {
              accessToken: project!.accessToken,
              refreshToken: project!.refreshToken,
              email: account?.email ?? '',
              userId: project!.userId,
            };

        return await syncAccount({ ...account!, sessionId: next.sessionId, host }, save);
      },
    };
  }, [account, save]);

  useEffect(() => {
    const syncActiveSession = async () => {
      if (!account || syncing.current) return;

      syncing.current = true;
      try {
        await syncAccount(account, save);
        onChanged?.();
      } catch {
        // The explicit Sync action remains available after a transient failure.
      } finally {
        syncing.current = false;
      }
    };

    return onCorpusChange(() => void syncActiveSession());
  }, [account, onChanged]);

  return (
    <Sessions
      api={api}
      activeSessionId={account?.sessionId ?? PERSONAL}
      hostedName={account?.host?.name}
      hostProject={account?.host}
      canHost={Boolean(account?.project)}
      signedIn={Boolean(account?.directory)}
      onChanged={onChanged}
    />
  );
}

export function WebSyncButton() {
  const [account, save] = useAccount();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sync() {
    if (account?.host && !account.sessionId) {
      setMessage('The joined session is missing its session ID. Rejoin it before syncing.');
      return;
    }
    if (!account) return;

    setBusy(true);
    setMessage(null);
    try {
      const result = await syncAccount(account, save);
      emitCorpusChange();
      setMessage(`Synced ${result.pulled} passage(s) from other devices.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <span
        style={{
          display: 'inline-block',
          width: 190,
          color: 'var(--muted)',
          fontSize: 12,
          textAlign: 'right',
        }}
      >
        {message ?? ''}
      </span>
      <Button tone="primary" disabled={busy} onClick={() => void sync()}>
        {busy ? 'Syncing…' : 'Sync now'}
      </Button>
    </span>
  );
}
