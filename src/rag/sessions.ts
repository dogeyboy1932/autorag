/**
 * Sessions — the unit a corpus is shared in.
 *
 * ## Why there is no such thing as a row without one
 *
 * An earlier shape left private rows with no session at all and gave sessions only
 * to things being shared. It worked, and it meant every query, policy and sync had
 * two cases: the null one and the real one. Two cases is how a filter comes to be
 * written for the case its author was thinking about, and a passage ends up
 * somewhere nobody chose to put it.
 *
 * So solo use is a session of one. `PERSONAL` is where anything kept without a
 * session in mind goes, and it is an ordinary session in every respect except that
 * nobody is invited to it. One code path, and `shared` is the only thing that
 * decides who can read a row.
 *
 * ## Why the id is a fixed string rather than a generated one
 *
 * Sessions live inside their owner's own project, so `personal` only has to be
 * unique within one database, and every user having a session of that name is
 * fine — they are different databases. It also has to be *stable across devices*:
 * a generated id would differ between two browsers belonging to the same person,
 * and their two halves of one corpus would sync past each other, each pushing rows
 * the other filtered out. A literal cannot drift.
 */
import type { SessionId } from '@/src/types';
import type { CloudConfig, Session as SupabaseSession } from './sync';

export const PERSONAL: SessionId = 'personal';

/** The session a row belongs to when nothing said otherwise. */
export const sessionOf = (id?: SessionId): SessionId => id ?? PERSONAL;

/**
 * Creates the session row in the owner's *own* project.
 *
 * Two rows exist for one shared session and they do different jobs. The directory
 * records that a code exists and who owns it, so a stranger can find out where to
 * look. This row is the one that actually authorises anything: every policy in the
 * owner's project reads `shared` from here, and until it exists and says true, a
 * resolved code reaches a database that shows the caller nothing.
 *
 * Written with the owner's own JWT, so `user_id` defaults to their auth.uid() and
 * the manage policy admits them.
 */
export async function createLocalSession(
  cloud: CloudConfig,
  session: SupabaseSession,
  input: { id: SessionId; name: string; shared: boolean },
): Promise<void> {
  const res = await fetch(`${cloud.url.replace(/\/$/, '')}/rest/v1/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: cloud.anonKey,
      Authorization: `Bearer ${session.accessToken}`,
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ id: input.id, name: input.name, shared: input.shared }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      detail = body.message ?? detail;
    } catch {
      /* keep the status */
    }
    throw new Error(`Could not create the session in your project: ${detail}`);
  }
}
