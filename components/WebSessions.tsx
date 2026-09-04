'use client';

import { useMemo } from 'react';
import Sessions, { type SessionsApi } from '@/components/Sessions';
import { useAccount } from '@/components/Shell';
import {
  inviteToSession,
  listSessions,
  publishSession,
  resolveSession,
} from '@/src/rag/directory';
import { createLocalSession, PERSONAL } from '@/src/rag/sessions';
import { syncNow } from '@/src/rag/sync';

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
      list: async () => (session ? await listSessions(session) : []),

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

        await publishSession(s, { code, name, openJoin, ownerUserId: s.userId });
        /*
         * Two rows, doing different jobs. The directory says a code exists and who
         * owns it; this one is what actually authorises reads, because every policy
         * in the owner's project consults `shared` here.
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
        const next = {
          ...account!,
          sessionId: target?.id ?? PERSONAL,
          host: target?.host,
        };
        save(next);

        /*
         * A member reaches the host's project as the anon role, holding the key the
         * session was shared with and signed in as nobody — which is exactly what a
         * member is. Own sessions use the attached project instead.
         */
        const project = account?.project;
        const cloud = target?.host
          ? { url: target.host.url, anonKey: target.host.anonKey, sessionId: target.id }
          : project && { url: project.url, anonKey: project.anonKey, sessionId: next.sessionId };
        if (!cloud) return { pulled: 0 };

        const auth = target?.host
          ? { accessToken: target.host.anonKey, refreshToken: '', email: '', userId: '' }
          : {
              accessToken: project!.accessToken,
              refreshToken: project!.refreshToken,
              email: account?.email ?? '',
              userId: project!.userId,
            };

        const result = await syncNow(cloud, auth);
        return { pulled: result.pulled };
      },
    };
  }, [account, save]);

  return (
    <Sessions
      api={api}
      activeSessionId={account?.sessionId ?? PERSONAL}
      hostedName={account?.host?.name}
      canHost={Boolean(account?.project)}
      signedIn={Boolean(account?.directory)}
      onChanged={onChanged}
    />
  );
}
