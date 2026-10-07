'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Sessions, { type SessionsApi } from '@/components/Sessions';
import { useAccount } from '@/components/Shell';
import {
  backend,
  findSession,
  inviteToSession,
  listSessions,
  publishSession,
} from '@/src/rag/directory';
import { PERSONAL } from '@/src/rag/sessions';
import { refresh as refreshCloud, syncNow } from '@/src/rag/sync';
import { setActiveSession } from '@/src/rag/store';
import { emitCorpusChange, onCorpusChange } from '@/src/rag/bus';
import { Button } from '@/components/ui';
import type { Account } from '@/components/Auth';

/**
 * Reconciles the active session with the account's own token.
 *
 * There is one project and one account, so there is nothing to choose between:
 * every session — personal, owned or joined — syncs with the same credentials, and
 * RLS decides what the account may touch.
 */
async function syncAccount(
  account: Account,
  save: (next: Account) => void,
): Promise<{ pulled: number; synced: boolean }> {
  const dir = account.directory;
  /*
   * No account means no cloud copy to reconcile with. That is the ordinary state of
   * a guest, so switching sessions must not report it as a failure — the passages
   * are already here.
   *
   * `WebSyncButton` calls this too, and there the silence would be wrong: pressing
   * Sync and being told nothing is worse than being told why. It says so itself.
   */
  if (!dir) return { pulled: 0, synced: false };

  const cloud = backend(account.sessionId ?? PERSONAL);
  const auth = {
    accessToken: dir.accessToken,
    refreshToken: dir.refreshToken,
    email: account.email,
    userId: dir.userId,
  };

  try {
    const result = await syncNow(cloud, auth);
    return { pulled: result.pulled, synced: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (!/jwt|expired|invalid token|401/i.test(detail)) throw err;

    const renewed = await refreshCloud(cloud, auth);
    save({
      ...account,
      directory: { ...dir, accessToken: renewed.accessToken, refreshToken: renewed.refreshToken },
    });
    const result = await syncNow(cloud, renewed);
    return { pulled: result.pulled, synced: true };
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
        /*
         * Read aloud and typed by hand, so no 0/O or 1/I. A code that cannot be
         * dictated over a call is not shareable, which is the only thing it is for.
         */
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const code = Array.from(
          crypto.getRandomValues(new Uint8Array(8)),
          (n) => alphabet[n % alphabet.length],
        ).join('');
        await publishSession(s, { code, name, openJoin, shared: true, ownerUserId: s.userId });
        return { code, name };
      },

      join: async (code) => {
        const found = await findSession(code.toUpperCase(), need());
        /*
         * One message for "no such code" and for "not yours to join". RLS
         * deliberately does not distinguish them, because telling them apart makes
         * this an oracle for which codes are real.
         */
        if (!found) {
          throw new Error(
            'No session with that code, or you have not been invited to it. Ask the owner to invite your email address.',
          );
        }
        return { code: found.code, name: found.name };
      },

      invite: async (code, email) => {
        await inviteToSession(need(), code, email);
      },

      switchTo: async (target) => {
        const next = { ...account!, sessionId: target?.id ?? PERSONAL };
        setActiveSession(next.sessionId);
        save(next);
        return await syncAccount(next, save);
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
      canCreate={Boolean(account?.directory && !account.demo)}
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
    if (!account) return;

    setBusy(true);
    setMessage(null);
    try {
      const result = await syncAccount(account, save);
      emitCorpusChange();
      setMessage(
        result.synced
          ? `Synced ${result.pulled} passage(s) from other devices.`
          : 'Working as a guest — sign in to sync your memory to your account.',
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="row">
      <span className="note" style={{ textAlign: 'right', maxWidth: 240 }}>
        {message ?? ''}
      </span>
      <Button tone="primary" disabled={busy} onClick={() => void sync()}>
        {busy ? 'Syncing…' : 'Sync now'}
      </Button>
    </span>
  );
}
