'use client';

import { useAccount } from '@/components/Shell';
import { PERSONAL } from '@/src/rag/sessions';

/**
 * Who you are, which corpus you are writing into, and the way back out.
 *
 * ## Why the session is here and not only in the Sessions panel
 *
 * "A session is what you see": in a session you see that session's passages and
 * nothing else, and everything you approve lands in whoever's project hosts it.
 * That is the one thing on this page a person can be wrong about without noticing —
 * you keep a passage, it goes somewhere you did not intend, and nothing on screen
 * looked any different.
 *
 * So it is stated permanently, next to the account, on every tab. Personal is named
 * outright rather than left blank: an empty space says "no session", and a reader
 * has to already know that means their own corpus.
 *
 * A demo account is labelled as such rather than showing the placeholder address it
 * was assigned — that address is not real, cannot be invited, and displaying it as
 * though the person chose it invites them to try.
 */
export default function AccountBar() {
  const [account, save] = useAccount();
  if (!account) return null;

  const who = account.demo ? 'demo' : account.guest ? 'guest' : account.email;
  const session = account.host?.name ?? account.sessionId ?? PERSONAL;
  const shared = Boolean(account.host);

  return (
    <span className="account-chip">
      <span className="account-who">{who}</span>
      <span className="account-sep" aria-hidden="true">·</span>
      <span
        className={shared ? 'account-session shared' : 'account-session'}
        title={
          shared
            ? `You are keeping into ${account.host!.name} — someone else's project. Everyone in this session can read what you approve.`
            : session === PERSONAL
              ? 'Your own corpus. Nobody else can see it.'
              : `Keeping into the session ${session}.`
        }
      >
        {session === PERSONAL ? 'personal' : session}
      </span>
      <button className="linky" onClick={() => save(null)}>
        {account.guest || account.demo ? 'exit' : 'sign out'}
      </button>
    </span>
  );
}
