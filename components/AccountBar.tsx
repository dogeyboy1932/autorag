'use client';

import { useAccount } from '@/components/Shell';

/**
 * Who you are signed in as, and the way back out.
 *
 * Small, and in the header rather than buried in a settings page, because the two
 * questions it answers are ones a person asks constantly once sessions exist:
 * whose account is this, and is this a real one or the demo.
 *
 * A demo account is labelled as such rather than showing the placeholder address
 * it was assigned — that address is not real, cannot be invited, and displaying it
 * as though the person chose it invites them to try.
 */
export default function AccountBar() {
  const [account, save] = useAccount();
  if (!account) return null;

  const who = account.demo
    ? 'demo account'
    : account.guest
      ? 'guest — nothing leaves this browser'
      : account.email;

  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
      <span style={{ color: 'var(--muted)' }}>{who}</span>
      <button
        onClick={() => save(null)}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--accent)',
          cursor: 'pointer',
          fontSize: 12,
          padding: 0,
        }}
      >
        {account.guest || account.demo ? 'exit' : 'sign out'}
      </button>
    </span>
  );
}
