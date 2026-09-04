'use client';

import { useEffect, useState } from 'react';
import Auth, { type Account } from '@/components/Auth';
import { askExtension } from '@/src/webmcp/extension-bridge';

const KEY = 'autorag.account';

/**
 * Who is using this, and what they can therefore do.
 *
 * Held in `localStorage` rather than memory so a reload does not throw someone
 * back to the sign-in screen with a corpus they can no longer reach. It carries
 * tokens, which is the same trade every browser app makes: the alternative is
 * signing in on every page load.
 *
 * Read defensively. A half-written or hand-edited value should land a person on
 * the sign-in screen, which is recoverable, rather than crashing the page, which
 * is not.
 */
export function useAccount(): [Account | null, (next: Account | null) => void, boolean] {
  const [account, setAccount] = useState<Account | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setAccount(JSON.parse(raw) as Account);
    } catch {
      /* treat anything unreadable as signed out */
    }
    setReady(true);
  }, []);

  const save = (next: Account | null) => {
    setAccount(next);
    try {
      if (next) localStorage.setItem(KEY, JSON.stringify(next));
      else localStorage.removeItem(KEY);
    } catch {
      /* private mode: it works for this tab and does not survive a reload */
    }

    /*
     * Hand it to the extension, if one is there.
     *
     * Identity is created here and only here, so the panel has no account form and
     * would otherwise have no way to know who is using it. This only ever travels
     * one way: `externally_connectable` lets a page message the extension, not the
     * reverse, and the extension cannot reach a tab that may not be open.
     *
     * Failure is silent by design — most people have no extension, and that is not
     * a fault worth interrupting anyone about.
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
  };

  return [account, save, ready];
}

/**
 * Shows the sign-in screen or the app, and nothing in between.
 *
 * `ready` exists so the app is not rendered for a frame before the stored account
 * is read — which would flash the sign-in screen at somebody who is signed in,
 * the most alarming possible thing for a page holding your notes to do.
 */
export default function Shell({ children }: { children: React.ReactNode }) {
  const [account, save, ready] = useAccount();
  if (!ready) return null;
  if (!account) return <Auth onSignedIn={save} />;
  return <>{children}</>;
}
