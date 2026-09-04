'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import Auth, { type Account } from '@/components/Auth';
import { askExtension } from '@/src/webmcp/extension-bridge';
import { setActiveSession } from '@/src/rag/store';

const KEY = 'autorag.account';

/**
 * Who is using this, and what they can therefore do.
 *
 * ## Why this is a context and not a hook with its own state
 *
 * It was a hook that called `useState` internally, and every component that used
 * it got a *separate copy* of the account. Four components did. Signing out
 * cleared the copy inside the header and nothing else, so the app stayed open on a
 * corpus belonging to an account that had just been discarded; signing in updated
 * the shell while the sessions panel went on believing nobody was there. Both
 * looked like buttons that did nothing.
 *
 * One provider, one value, every reader in agreement. A hook that owns state is a
 * hook that cannot be shared, and this is state two parts of the page must never
 * disagree about.
 *
 * ## Why localStorage
 *
 * So a reload does not throw someone back to the sign-in screen with a corpus they
 * can no longer reach. It carries tokens, which is the trade every browser app
 * makes; the alternative is signing in on every page load.
 */

interface AccountContext {
  account: Account | null;
  save: (next: Account | null) => void;
  ready: boolean;
}

const Ctx = createContext<AccountContext | null>(null);

export function useAccount(): [Account | null, (next: Account | null) => void, boolean] {
  const ctx = useContext(Ctx);
  /*
   * Loud rather than silently signed-out. A component rendered outside the
   * provider would otherwise show a permanent "sign in first" and look like an
   * auth bug rather than a missing wrapper.
   */
  if (!ctx) throw new Error('useAccount used outside <Shell>');
  return [ctx.account, ctx.save, ctx.ready];
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setAccount(JSON.parse(raw) as Account);
    } catch {
      /* anything unreadable means signed out, which is recoverable */
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) setActiveSession(account?.sessionId);
  }, [account?.sessionId, ready]);

  const save = useCallback((next: Account | null) => {
    setAccount(next);
    try {
      if (next) localStorage.setItem(KEY, JSON.stringify(next));
      else localStorage.removeItem(KEY);
    } catch {
      /* private mode: works for this tab, does not survive a reload */
    }

    /*
     * Hand it to the extension, if one is there. Only ever this direction:
     * `externally_connectable` lets a page message the extension, not the reverse,
     * and the extension cannot reach a tab that may not be open.
     *
     * Silent on failure by design — most people have no extension, which is not a
     * fault worth interrupting anyone about.
     */
    void askExtension({
      kind: 'setAccount',
      account: next && {
        email: next.email,
        demo: next.demo,
        guest: next.guest,
        directory: next.directory,
        sessionId: next.sessionId,
        host: next.host,
      },
    }).catch(() => {});
  }, []);

  /*
   * Push the account on every page load, not only when it changes.
   *
   * `save` fires on sign-in and sign-out, which covers somebody who signs in with
   * the extension already installed. It does nothing for the far more common
   * order: already signed in, *then* install the extension, or open the panel for
   * the first time on a machine where the session has been sitting in
   * localStorage for a week. Nothing changed, so nothing was ever sent, and the
   * panel sat on "Sign in" with a Check again button that could only re-read an
   * empty box. Signing out and back in was the only way through, which is a
   * workaround a person should never have to discover.
   *
   * So: whenever this page loads with somebody signed in, tell the extension. It
   * is idempotent and costs one message the extension ignores if it already
   * agrees.
   */
  useEffect(() => {
    if (!ready || !account) return;
    void askExtension({
      kind: 'setAccount',
      account: {
        email: account.email,
        demo: account.demo,
        guest: account.guest,
        directory: account.directory,
        sessionId: account.sessionId,
        host: account.host,
      },
    }).catch(() => {});
  }, [ready, account]);

  const value = useMemo(() => ({ account, save, ready }), [account, save, ready]);

  return (
    <Ctx.Provider value={value}>
      {/*
        `ready` keeps the app from rendering for a frame before the stored account
        is read, which would flash the sign-in screen at somebody who is signed in
        — the most alarming thing a page holding your notes can do on load.
      */}
      {!ready ? null : account ? children : <Auth onSignedIn={save} />}
    </Ctx.Provider>
  );
}
