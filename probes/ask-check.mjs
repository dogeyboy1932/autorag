/**
 * Does the demo endpoint answer, count, and refuse?
 *
 *   pnpm ask:check      # needs ANTHROPIC_API_KEY in .env and .env2 for the counter
 *
 * Runs the Netlify Function in this process — no deploy, no netlify dev — because
 * the thing worth checking is its logic, and a deploy is a slow way to discover
 * that a variable is named wrong.
 *
 * It spends one real API call. That is the point: the failures this is here to
 * catch (a rejected header, a model name the account cannot reach, a body shape
 * the API refuses) are all things a mock would happily accept.
 *
 * The counter row it writes is deleted afterwards, including on failure.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const readEnv = (name) => {
  try {
    return Object.fromEntries(
      readFileSync(resolve(root, name), 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
        .map((l) => [
          l.slice(0, l.indexOf('=')).trim(),
          l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, ''),
        ]),
    );
  } catch {
    return null;
  }
};

const corpusEnv = readEnv('.env') ?? {};
const directoryEnv = readEnv('.env2') ?? {};

if (!corpusEnv.ANTHROPIC_API_KEY) {
  console.log('SKIP  no ANTHROPIC_API_KEY in .env');
  process.exit(0);
}

process.env.ANTHROPIC_API_KEY = corpusEnv.ANTHROPIC_API_KEY;
process.env.DIRECTORY_URL = directoryEnv.SUPABASE_URL ?? '';
process.env.DIRECTORY_SECRET_KEY = directoryEnv.SUPABASE_SECRET_KEY ?? '';

const { default: handler } = await import('../netlify/functions/ask.ts');

let pass = 0;
const failures = [];
const ok = (cond, name, note = '') => {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${note ? ` — ${note}` : ''}`);
  }
};

// A fixed address so the row is predictable and can be cleaned up.
const ADDRESS = '203.0.113.7';
const post = (body, headers = {}) =>
  handler(
    new Request('https://example.invalid/.netlify/functions/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nf-client-connection-ip': ADDRESS, ...headers },
      body: JSON.stringify(body),
    }),
  );

const dirRest = (path, init = {}) =>
  fetch(`${process.env.DIRECTORY_URL.replace(/\/$/, '')}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: process.env.DIRECTORY_SECRET_KEY,
      Authorization: `Bearer ${process.env.DIRECTORY_SECRET_KEY}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });

const sha256 = async (t) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
const key = await sha256(ADDRESS);

try {
  await dirRest(`demo_usage?key=eq.${key}`, { method: 'DELETE' });

  // --- shape guards, which cost nothing --------------------------------------
  const notPost = await handler(new Request('https://example.invalid/x', { method: 'GET' }));
  ok(notPost.status === 405, 'a GET is refused', String(notPost.status));

  const empty = await post({ messages: [] });
  ok(empty.status === 400, 'an empty conversation is refused before any spend', String(empty.status));

  // --- one real answer -------------------------------------------------------
  const res = await post({
    system: 'Answer in exactly one short sentence.',
    messages: [{ role: 'user', content: 'Say the word tidal and nothing else.' }],
  });
  const body = await res.json();
  ok(res.status === 200, 'the endpoint answers', JSON.stringify(body).slice(0, 200));
  const text = body?.content?.[0]?.text ?? '';
  ok(text.length > 0, 'the answer has content', JSON.stringify(body).slice(0, 200));
  ok(
    res.headers.get('x-autorag-demo-used') === '1',
    'it reports the first answer against the cap',
    res.headers.get('x-autorag-demo-used'),
  );

  const rows = await (await dirRest(`demo_usage?select=count&key=eq.${key}`)).json();
  ok(rows[0]?.count === 1, 'the count is recorded in the directory', JSON.stringify(rows));

  ok(
    !JSON.stringify(body).includes(process.env.ANTHROPIC_API_KEY),
    'the key is not echoed back to the caller',
    'KEY LEAKED IN RESPONSE',
  );

  // --- the cap, without spending ten calls -----------------------------------
  await dirRest('demo_usage', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key, count: 10 }),
  });
  const capped = await post({ messages: [{ role: 'user', content: 'again' }] });
  const cappedBody = await capped.json();
  ok(capped.status === 429, 'the eleventh answer is refused', String(capped.status));
  ok(
    /limit per visitor/i.test(cappedBody.error ?? ''),
    'and says why, in words a visitor can act on',
    cappedBody.error,
  );

  // --- a counter it cannot reach pauses rather than opens --------------------
  const goodUrl = process.env.DIRECTORY_URL;
  process.env.DIRECTORY_URL = 'https://127.0.0.1:9';
  const broken = await post({ messages: [{ role: 'user', content: 'hello' }] });
  process.env.DIRECTORY_URL = goodUrl;
  ok(
    broken.status === 503,
    'an unreachable counter pauses the demo instead of failing open',
    String(broken.status),
  );
} catch (err) {
  ok(false, 'run completed', String(err));
} finally {
  await dirRest(`demo_usage?key=eq.${key}`, { method: 'DELETE' }).catch(() => {});
}

console.log(`\n${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
