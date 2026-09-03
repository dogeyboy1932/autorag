'use client';

import { useState } from 'react';
import { Button, Panel } from '@/components/ui';
import { directoryConfigured, listOpenSessions, resolveSession, signInAnonymously } from '@/src/rag/directory';
import { syncNow } from '@/src/rag/sync';

/**
 * A way in without an account, so the product can be judged rather than described.
 *
 * ## What it actually does
 *
 * Signs in anonymously to the directory, asks which session is open to anyone,
 * gets that session's project credentials from `credentials_for`, and pulls it
 * into this browser's own IndexedDB. From there everything on the page — search,
 * review, screening, the tool surface — is the ordinary product working on a real
 * corpus. Nothing about demo mode is a special path through the app; it is a sync.
 *
 * ## Why it discovers the session instead of being given a code
 *
 * A code compiled into the build has to be regenerated and redeployed whenever the
 * demo corpus is rebuilt, and is wrong-and-silent in between — a stale code
 * resolves to nothing and looks exactly like a broken demo. The directory already
 * knows which sessions are open, so it is asked.
 *
 * ## What it says out loud
 *
 * That the corpus is shared and writable. Demo mode deliberately allows the
 * destructive verbs, because a judge who cannot try forgetting a source has not
 * seen the product — but the person in front of it should know that what they
 * delete, they delete for the next visitor too.
 */
export default function DemoMode({ onLoaded }: { onLoaded?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!directoryConfigured()) return null;

  async function start() {
    setBusy(true);
    setMsg('Signing in…');
    try {
      const session = await signInAnonymously();

      setMsg('Looking for a shared corpus…');
      const open = await listOpenSessions(session);
      const demo = open[0];
      if (!demo) {
        /*
         * Reported as the absence it is. "Demo unavailable" would send someone
         * looking at this code, and the cause is that nobody has published an open
         * session yet — which is a thing the author does in the extension, not a
         * fault here.
         */
        setMsg('No shared corpus is published right now. Nothing to demo yet.');
        return;
      }

      setMsg(`Opening ${demo.name}…`);
      const creds = await resolveSession(demo.code, session);
      if (!creds) {
        setMsg('That corpus exists but would not release its credentials.');
        return;
      }

      /*
       * Synced as the anon role against the host's project: no user of theirs, no
       * JWT, just the publishable key their session was shared with. Which is
       * exactly what a member is, so this is the member path and not a back door.
       */
      const result = await syncNow(
        { url: creds.projectUrl, anonKey: creds.anonKey, sessionId: demo.code },
        { accessToken: creds.anonKey, refreshToken: '', email: '', userId: '' },
        (m) => setMsg(m),
      );
      setDone(true);
      setMsg(
        result.pulled > 0
          ? `${demo.name} is loaded — ${result.pulled} passage(s). Search it, review what is pending, ask it something.`
          : `${demo.name} is open but empty. Nothing has been kept into it yet.`,
      );
      onLoaded?.();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Try it on a real corpus"
      right={
        !done && (
          <Button tone="primary" onClick={() => void start()} disabled={busy}>
            {busy ? 'Loading…' : 'Demo mode'}
          </Button>
        )
      }
    >
      <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
        No account and no install: this pulls a shared corpus into your browser and lets you
        use the whole thing on it — search, the review queue, screening, and the tools an
        agent would call.
      </p>
      {msg && (
        <p style={{ margin: '10px 0 0', fontSize: 13, color: done ? 'var(--accent)' : 'var(--muted)' }}>
          {msg}
        </p>
      )}
      <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--muted)' }}>
        The corpus is shared and you can change it, including forgetting sources — that is
        deliberate, since a memory you cannot prune is not the thing being shown. What you
        remove goes for the next visitor too.
      </p>
    </Panel>
  );
}
