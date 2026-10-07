/**
 * Autorag's one Supabase project — accounts, sessions, and everyone's passages.
 *
 * ## What it holds
 *
 * Who someone is, which sessions exist and who was invited to them, how many demo
 * answers an address has spent, and the mirrored corpus itself. It used to be only
 * the first three — a phone book that mapped a session code to the owner's *own*
 * Supabase project — and members reached that project as the `anon` role with the
 * owner's key. One project means everybody arrives with a JWT of their own, so
 * RLS decides every row by who is asking. See `supabase/autorag.sql`.
 *
 * ## Why the key below is in the repo, and why the other one never can be
 *
 * `publishableKey` is committed deliberately. Supabase publishable keys are
 * designed to ship in client code: they grant nothing on their own, and row-level
 * security scopes every row to the caller. Every client has to reach this project,
 * and the extension ships as a zip anyone can unzip and read.
 *
 * The **secret** key bypasses RLS and can read every person's passages. It stays
 * in `.env`, git-ignored, used only by the probes and the Netlify Function. If you
 * find yourself wanting it in this file, the design has gone wrong.
 */

import type { CloudConfig, Session } from './sync';
import { backendFetch } from './backend';

export const DIRECTORY = {
  url: 'https://qkupjhuroorzijbfqdtv.supabase.co',
  /*
   * Paste the project's `sb_publishable_…` key here — never the
   * `sb_secret_…` one. `pnpm dir:check` fails loudly while this is a placeholder,
   * so an unconfigured build cannot quietly ship.
   */
  publishableKey: 'sb_publishable_l8Ko0A6PTI3AT2cWl2rMlA_5Bx2XBY4',
} as const;

export const directoryConfigured = () =>
  !DIRECTORY.url.includes('REPLACE_ME') && !DIRECTORY.publishableKey.includes('REPLACE_ME');

/**
 * Where a sync goes: always this project, scoped to one session.
 *
 * There is no other destination any more, so nothing stores a URL or key for the
 * corpus — the compiled-in pair is the only one, and a stale stored copy cannot
 * point a sync somewhere else.
 */
export const backend = (sessionId?: string): CloudConfig => ({
  url: DIRECTORY.url,
  anonKey: DIRECTORY.publishableKey,
  ...(sessionId ? { sessionId } : {}),
});

const url = (path: string) => `${DIRECTORY.url.replace(/\/$/, '')}/${path}`;

function headers(token?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    apikey: DIRECTORY.publishableKey,
    Authorization: `Bearer ${token ?? DIRECTORY.publishableKey}`,
  };
}

async function fail(res: Response): Promise<never> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { message?: string; msg?: string };
    detail = body.msg ?? body.message ?? detail;
  } catch {
    /* keep the status */
  }
  throw new Error(detail);
}

/** A session's row: its name and who may use it. Its passages carry `session_id = code`. */
export interface DirectorySession {
  code: string;
  name: string;
  open_join: boolean;
  shared: boolean;
  owner_user_id: string;
}

const SESSION_COLUMNS = 'code,name,open_join,shared,owner_user_id';

/**
 * Signs in without an account, for demo mode.
 *
 * Anonymous sign-ins are off by default in a new Supabase project, and the error
 * for that is `Anonymous sign-ins are disabled` — which is accurate and reads like
 * a client bug. Named here so it is reported as the setting it is.
 */
export async function signInAnonymously(): Promise<Session> {
  const res = await backendFetch(url('auth/v1/signup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: DIRECTORY.publishableKey },
    body: '{}',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { msg?: string };
    if (/anonymous sign-ins are disabled/i.test(body.msg ?? '')) {
      throw new Error(
        'The Autorag Supabase project has anonymous sign-ins turned off. In Supabase: Authentication → Sign In / Providers → Anonymous sign-ins.',
      );
    }
    throw new Error(body.msg ?? `HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    user?: { id?: string };
  };
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    email: '',
    userId: body.user?.id ?? '',
  };
}

/**
 * Signing in and signing up, kept apart.
 *
 * These used to be one function that tried a password grant and fell back to
 * creating an account whenever it failed — for any reason at all. So a wrong
 * password did not report a wrong password: it went on to attempt a signup, which
 * Supabase refused with "User already registered", and *that* was shown to the
 * person. Told they were already registered while being refused entry, with the
 * Sign in / Create account choice they had just made ignored.
 *
 * Each verb now does one thing and reports its own failure. A person's stated
 * intent is information, and guessing past it produced an error message about the
 * opposite of what went wrong.
 *
 * One account, in the one project: it owns sessions, receives invites, and is
 * what every passage's `user_id` refers to.
 */
async function attempt(path: string, email: string, password: string) {
  const res = await backendFetch(url(`auth/v1/${path}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: DIRECTORY.publishableKey },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    user?: { id?: string };
    msg?: string;
    message?: string;
    error_description?: string;
  };
  return { ok: res.ok, status: res.status, body };
}

/**
 * "Confirm email" is on, in the two shapes it arrives as.
 *
 * With it enabled, signup either returns a user and no session, or — on the free
 * tier, once a couple of addresses have been tried — refuses with a mail rate
 * limit. Neither response names the setting, and the link it wants to send points
 * at a Site URL nothing serves.
 */
const CONFIRM_EMAIL_HELP =
  'The Autorag Supabase project has "Confirm email" turned on, so it tries to email a confirmation ' +
  'link that nothing here can receive. Turn it off: Supabase → Authentication → Sign In / ' +
  'Providers → Email → Confirm email.';

const detailOf = (b: { msg?: string; message?: string; error_description?: string }) =>
  b.msg ?? b.message ?? b.error_description ?? '';

export async function accountSignIn(email: string, password: string): Promise<Session> {
  const r = await attempt('token?grant_type=password', email, password);
  if (!r.body.access_token) {
    const detail = detailOf(r.body);
    if (/invalid login credentials/i.test(detail)) {
      /*
       * Named as the password, and *not* as a missing account. An earlier version
       * guessed the account did not exist and tried to create one, which reported
       * "User already registered" — the exact opposite of the truth.
       */
      throw new Error(
        'Wrong password for that email, or no account with it yet. If you have not made one, ' +
          'choose "or create one" below.',
      );
    }
    if (/email not confirmed/i.test(detail)) throw new Error(CONFIRM_EMAIL_HELP);
    throw new Error(`Sign-in failed: ${detail || `HTTP ${r.status}`}`);
  }
  return {
    accessToken: r.body.access_token,
    refreshToken: r.body.refresh_token ?? '',
    email,
    userId: r.body.user?.id ?? '',
  };
}

export async function accountSignUp(email: string, password: string): Promise<Session> {
  const r = await attempt('signup', email, password);
  const detail = detailOf(r.body);

  if (/already registered/i.test(detail)) {
    throw new Error('That email already has an account. Choose "or sign in" and use its password.');
  }
  if (!r.body.access_token) {
    if (/rate limit/i.test(detail)) {
      throw new Error(`${CONFIRM_EMAIL_HELP} (It is currently refusing with a mail rate limit.)`);
    }
    // A user with no session means the confirmation email is the missing step.
    if (r.body.user || /confirm/i.test(detail)) throw new Error(CONFIRM_EMAIL_HELP);
    throw new Error(`Could not create the account: ${detail || `HTTP ${r.status}`}`);
  }
  return {
    accessToken: r.body.access_token,
    refreshToken: r.body.refresh_token ?? '',
    email,
    userId: r.body.user?.id ?? '',
  };
}

/** Sign in, or create the account if there is genuinely none. Used by automation. */
export async function signInOrUp(email: string, password: string): Promise<Session> {
  try {
    return await accountSignIn(email, password);
  } catch {
    return await accountSignUp(email, password);
  }
}


/**
 * A session the caller may use, by code — or null.
 *
 * Asked of `sessions` directly, and RLS is the whole answer: a row is visible only
 * if the caller owns it, was invited, or it is shared or open. So a code that does
 * not exist and one the caller may not use both come back empty, and that
 * conflation is intentional — telling them apart would make this an oracle for
 * which codes are real.
 */
export async function findSession(code: string, session: Session): Promise<DirectorySession | null> {
  const res = await backendFetch(
    url(`rest/v1/sessions?select=${SESSION_COLUMNS}&code=eq.${encodeURIComponent(code)}`),
    { headers: headers(session.accessToken) },
  );
  if (!res.ok) await fail(res);
  const rows = (await res.json()) as DirectorySession[];
  return rows[0] ?? null;
}

/**
 * The sessions anyone may join, for demo mode.
 *
 * Discovered rather than configured. The alternative was compiling a code into
 * the build, which would have to be regenerated and redeployed every time the
 * demo corpus was rebuilt — and would be wrong-and-silent in between, since a
 * stale code resolves to nothing and looks exactly like a broken demo.
 *
 * The `visible_sessions` policy already lets an unauthenticated caller see rows
 * with `open_join`, so this asks the directory what is open instead of being
 * told. Nothing else is listed: a shared session is reachable by its code, never
 * by browsing.
 */
export async function listOpenSessions(session?: Session): Promise<DirectorySession[]> {
  const res = await backendFetch(
    url(`rest/v1/sessions?select=${SESSION_COLUMNS}&open_join=is.true`),
    { headers: headers(session?.accessToken) },
  );
  if (!res.ok) await fail(res);
  return (await res.json()) as DirectorySession[];
}

/** Every session this person owns, including both private and open sessions. */
export async function listSessions(session: Session): Promise<DirectorySession[]> {
  const res = await backendFetch(
    url(
      `rest/v1/sessions?select=${SESSION_COLUMNS}&owner_user_id=eq.${encodeURIComponent(session.userId)}`,
    ),
    {
    headers: headers(session.accessToken),
    },
  );
  if (!res.ok) await fail(res);
  return (await res.json()) as DirectorySession[];
}

/**
 * Creates a session. One row does the whole job: it names the session, and its
 * `shared` and `open_join` flags are what every corpus policy reads.
 */
export async function publishSession(
  session: Session,
  input: { code: string; name: string; openJoin?: boolean; shared?: boolean; ownerUserId: string },
): Promise<void> {
  const res = await backendFetch(url('rest/v1/sessions'), {
    method: 'POST',
    headers: { ...headers(session.accessToken), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      code: input.code,
      name: input.name,
      open_join: input.openJoin ?? false,
      shared: input.shared ?? true,
      owner_user_id: input.ownerUserId,
    }),
  });
  if (!res.ok) await fail(res);
}

/** Invites an email address to a session the caller owns. */
export async function inviteToSession(
  session: Session,
  sessionCode: string,
  email: string,
): Promise<void> {
  const res = await backendFetch(url('rest/v1/invites'), {
    method: 'POST',
    headers: { ...headers(session.accessToken), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ session_code: sessionCode, email: email.trim().toLowerCase() }),
  });
  if (!res.ok) await fail(res);
}
