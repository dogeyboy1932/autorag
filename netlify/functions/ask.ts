/**
 * The demo's answering endpoint.
 *
 * ## Why this exists at all
 *
 * The site is a static export, so there is no server and no way to keep a secret
 * in it. An `ANTHROPIC_API_KEY` shipped in the bundle is readable by anyone who
 * opens devtools and spendable by anyone who reads it — not a risk to weigh, a
 * certainty to avoid. This Function is the one place in the project that holds
 * the author's key, and it never hands it to a browser.
 *
 * The extension does not use this. It calls Anthropic directly with the person's
 * own key, which is the right trade there: their key, their spend, their
 * conversation. This path exists so a judge can try the product without one, and
 * the page says so.
 *
 * ## Why the cap is counted here and not in the page
 *
 * Every client-side counter is advisory. A number in React resets on reload; one
 * in localStorage resets on clearing site data; either can be edited from the
 * console. Since the spend is the author's, the count has to live somewhere the
 * spender controls — a row in the directory that only this Function's secret key
 * can read or write, keyed by a hash of the requesting address.
 *
 * The address itself is never stored. A hash is enough to count against and
 * cannot be turned back into a visitor.
 *
 * It is defeated by a VPN and that is fine: the cap is there so one person cannot
 * drain the budget by holding down a key, not to be an identity system. Set a
 * spend limit on the key as well.
 */

const MAX_ANSWERS = 10;
const MAX_TOKENS = 1024;

interface AskBody {
  system?: string;
  messages?: { role: 'user' | 'assistant'; content: unknown }[];
  model?: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'POST only' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  /*
   * Named for the directory, not `SUPABASE_*`, because this project has two
   * Supabase projects and the generic name is ambiguous between them. The counter
   * lives in the *directory*; pointed at the corpus project instead it would find
   * no `demo_usage` table, and the failure would arrive as "the demo is paused"
   * with nothing saying which database was wrong. Copying .env straight into
   * Netlify is the obvious thing to do and would have done exactly that.
   */
  const directoryUrl = process.env.DIRECTORY_URL;
  const directoryKey = process.env.DIRECTORY_SECRET_KEY;
  if (!apiKey) {
    /*
     * Named precisely. "Demo unavailable" would send whoever is looking at it to
     * the client code, and the cause is an environment variable on the deploy.
     */
    return json(503, {
      error: 'The demo is not configured: ANTHROPIC_API_KEY is not set on this deploy.',
    });
  }

  let body: AskBody;
  try {
    body = (await request.json()) as AskBody;
  } catch {
    return json(400, { error: 'Body must be JSON.' });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json(400, { error: 'Nothing to answer: messages is empty.' });
  }

  /*
   * Netlify puts the real client address here. `x-forwarded-for` is a list when
   * proxies chain, and the first entry is the client — the rest are the hops, and
   * counting against a hop would cap everyone behind it at once.
   */
  const address =
    request.headers.get('x-nf-client-connection-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown';

  let used = 0;
  const canCount = Boolean(directoryUrl && directoryKey);
  const key = await sha256(address);
  const rest = `${directoryUrl?.replace(/\/$/, '')}/rest/v1/demo_usage`;
  const authHeaders = {
    apikey: directoryKey ?? '',
    Authorization: `Bearer ${directoryKey ?? ''}`,
    'content-type': 'application/json',
  };

  if (canCount) {
    try {
      const res = await fetch(`${rest}?select=count&key=eq.${key}`, { headers: authHeaders });
      const rows = (await res.json()) as { count: number }[];
      used = rows[0]?.count ?? 0;
    } catch {
      /*
       * A directory that cannot be reached must not become a free-for-all. Failing
       * open here would mean an outage is also an unmetered budget, which is the
       * expensive direction to be wrong in.
       */
      return json(503, { error: 'Cannot reach the usage counter, so the demo is paused.' });
    }
    if (used >= MAX_ANSWERS) {
      return json(429, {
        error: `That is ${MAX_ANSWERS} answers, which is the limit per visitor — they are billed to the author. Add your own API key in the extension for unlimited use.`,
        used,
        limit: MAX_ANSWERS,
      });
    }
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: body.model ?? 'claude-haiku-4-5-20251001',
      // Capped here rather than trusted from the client, which sets the ceiling on
      // what one request can cost.
      max_tokens: MAX_TOKENS,
      ...(body.system ? { system: body.system } : {}),
      messages: body.messages,
    }),
  });

  const answer = await upstream.text();
  if (!upstream.ok) {
    return new Response(answer, {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  /*
   * Counted after a successful answer, not before. Charging someone for a request
   * that failed upstream spends their allowance on the author's outage.
   */
  if (canCount) {
    await fetch(`${rest}?on_conflict=key`, {
      method: 'POST',
      headers: { ...authHeaders, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ key, count: used + 1 }),
    }).catch(() => {
      /* the answer is already sent; a lost increment is cheaper than a lost reply */
    });
  }

  return new Response(answer, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-autorag-demo-used': String(used + 1),
      'x-autorag-demo-limit': String(MAX_ANSWERS),
    },
  });
}
