/**
 * The directory — how one person's session code finds another person's corpus.
 *
 * ## What this project is
 *
 * A phone book, and nothing else. It maps a session code to the Supabase project
 * that actually holds the passages, records who was invited, and counts demo
 * usage. No passage, chunk or embedding is ever stored here. Corpora live in
 * their owners' own projects, which is what lets someone be handed a session
 * without being handed a database.
 *
 * ## Why the key below is in the repo, and why the other one never can be
 *
 * `publishableKey` is committed deliberately. Supabase publishable keys are
 * designed to ship in client code: they grant nothing on their own, and row-level
 * security scopes every row to the caller. There is also no version of this
 * feature where the key stays private — every user's browser has to reach the
 * directory to resolve a code, so it is on every client by necessity, and the
 * extension ships as a zip anyone can unzip and read.
 *
 * The directory's **secret** key is a different thing entirely: it bypasses RLS
 * and can read every row of `profiles`, which is where other people's project
 * credentials live. It stays in `.env2`, git-ignored, used only by
 * `pnpm dir:check` and the Netlify Function. If you find yourself wanting it in
 * this file, the design has gone wrong.
 *
 * What actually protects this project is asserted by `pnpm dir:check`: signed in
 * as a real anonymous user holding nothing but the key below, a stranger sees an
 * open session and not a private one, and `credentials_for` refuses to hand over
 * the private session's credentials.
 */

import type { CloudConfig, Session } from './sync';

export const DIRECTORY = {
  url: 'https://qkupjhuroorzijbfqdtv.supabase.co',
  /*
   * Paste the directory project's `sb_publishable_…` key here — never the
   * `sb_secret_…` one. `pnpm dir:check` fails loudly while this is a placeholder,
   * so an unconfigured build cannot quietly ship.
   */
  publishableKey: 'sb_publishable_l8Ko0A6PTI3AT2cWl2rMlA_5Bx2XBY4',
} as const;

export const directoryConfigured = () =>
  !DIRECTORY.url.includes('REPLACE_ME') && !DIRECTORY.publishableKey.includes('REPLACE_ME');

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

/** A session as the directory knows it — a name and a code, never any content. */
export interface DirectorySession {
  code: string;
  name: string;
  open_join: boolean;
  owner_user_id: string;
}

/**
 * Signs in without an account, for demo mode.
 *
 * Anonymous sign-ins are off by default in a new Supabase project, and the error
 * for that is `Anonymous sign-ins are disabled` — which is accurate and reads like
 * a client bug. Named here so it is reported as the setting it is.
 */
export async function signInAnonymously(): Promise<Session> {
  const res = await fetch(url('auth/v1/signup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: DIRECTORY.publishableKey },
    body: '{}',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { msg?: string };
    if (/anonymous sign-ins are disabled/i.test(body.msg ?? '')) {
      throw new Error(
        'The directory project has anonymous sign-ins turned off. In Supabase: Authentication → Sign In / Providers → Anonymous sign-ins.',
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
 * A person has two accounts and should never think about it: one here, which owns
 * sessions and receives invites, and one in their own Supabase project if they
 * host a corpus. Auth users are per-project, so these are genuinely different
 * users that happen to share an email.
 */
async function attempt(path: string, email: string, password: string) {
  const res = await fetch(url(`auth/v1/${path}`), {
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
  'The directory project has "Confirm email" turned on, so it tries to email a confirmation ' +
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
 * Turns a session code into the credentials of the project that holds it.
 *
 * Deliberately a function call rather than a select on `profiles`: the rule about
 * who may have someone else's credentials lives in `credentials_for` and nowhere
 * else, so there is one place to read and one place to get it wrong.
 *
 * Returns null for a code that does not exist *and* for one the caller may not
 * have, and that conflation is intentional — distinguishing them would turn this
 * into an oracle for which codes are real.
 */
export async function resolveSession(
  code: string,
  session?: Session,
): Promise<{ projectUrl: string; anonKey: string } | null> {
  const res = await fetch(url('rest/v1/rpc/credentials_for'), {
    method: 'POST',
    headers: headers(session?.accessToken),
    body: JSON.stringify({ session_code: code }),
  });
  if (!res.ok) await fail(res);
  const rows = (await res.json()) as { project_url: string; anon_key: string }[];
  const row = rows[0];
  if (!row?.project_url || !row?.anon_key) return null;
  return { projectUrl: row.project_url, anonKey: row.anon_key };
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
 * told. Nothing else is visible: a private session is not in this list, and its
 * credentials are not reachable through it.
 */
export async function listOpenSessions(session?: Session): Promise<DirectorySession[]> {
  const res = await fetch(
    url('rest/v1/sessions?select=code,name,open_join,owner_user_id&open_join=is.true'),
    { headers: headers(session?.accessToken) },
  );
  if (!res.ok) await fail(res);
  return (await res.json()) as DirectorySession[];
}

/** Every session this person owns, including both private and open sessions. */
export async function listSessions(session: Session): Promise<DirectorySession[]> {
  const res = await fetch(
    url(
      `rest/v1/sessions?select=code,name,open_join,owner_user_id&owner_user_id=eq.${encodeURIComponent(session.userId)}`,
    ),
    {
    headers: headers(session.accessToken),
    },
  );
  if (!res.ok) await fail(res);
  return (await res.json()) as DirectorySession[];
}

/**
 * Publishes a session so other people can find it.
 *
 * The corpus itself is not touched here. This records that a code exists and who
 * owns it; the passages stay in the owner's project, reachable only once
 * `credentials_for` agrees to hand over its credentials.
 */
export async function publishSession(
  session: Session,
  input: { code: string; name: string; openJoin?: boolean; ownerUserId: string },
): Promise<void> {
  const res = await fetch(url('rest/v1/sessions'), {
    method: 'POST',
    headers: { ...headers(session.accessToken), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      code: input.code,
      name: input.name,
      open_join: input.openJoin ?? false,
      owner_user_id: input.ownerUserId,
    }),
  });
  if (!res.ok) await fail(res);
}

/**
 * Records where this person's own corpus lives, so a session they own can be
 * resolved by someone else.
 *
 * `anonKey` here is the *publishable* key of their own project — the same one
 * they typed into Settings. Handing it to an invitee is the entire mechanism, and
 * it is why an invite is preferred over a code: a code is a bearer token, while
 * an invite releases credentials only to an address the owner named.
 */
export async function publishProfile(
  session: Session,
  input: { userId: string; email: string; cloud: CloudConfig },
): Promise<void> {
  const res = await fetch(url('rest/v1/profiles'), {
    method: 'POST',
    headers: { ...headers(session.accessToken), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      user_id: input.userId,
      email: input.email,
      project_url: input.cloud.url,
      anon_key: input.cloud.anonKey,
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
  const res = await fetch(url('rest/v1/invites'), {
    method: 'POST',
    headers: { ...headers(session.accessToken), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ session_code: sessionCode, email: email.trim().toLowerCase() }),
  });
  if (!res.ok) await fail(res);
}
