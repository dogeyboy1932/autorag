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

export const PERSONAL: SessionId = 'personal';

/** The session a row belongs to when nothing said otherwise. */
export const sessionOf = (id?: SessionId): SessionId => id ?? PERSONAL;
