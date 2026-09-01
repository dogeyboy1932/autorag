/**
 * Retrieval benchmark. Drives the running app through real WebMCP tool calls in
 * headless Chrome — no internal imports, so it measures what an agent measures.
 *
 *   pnpm dev                       # in one terminal
 *   node bench/retrieval.mjs       # in another
 *
 * Reports two numbers:
 *   top-1          did the right source rank first
 *   usable verdict did the app's own confidence match reality — the one that
 *                  matters, because it decides whether an agent answers or declines
 */

import puppeteer from 'puppeteer-core';
import { SEED, QUERIES } from './queries.mjs';

const URL = process.env.AUTORAG_URL ?? 'http://localhost:3111/';
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-features=WebMCP'],
  protocolTimeout: 600000,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });
process.stdout.write('waiting for embedding model… ');
await page.waitForFunction(() => document.body.innerText.includes('model ready'), {
  timeout: 300000, polling: 1000,
});
console.log('ready');

await page.evaluate(() => {
  window.__call = async (name, args) => {
    const tool = (await document.modelContext.getTools()).find((t) => t.name === name);
    if (!tool) return { __missing: name };
    return JSON.parse(await document.modelContext.executeTool(tool, JSON.stringify(args ?? {})));
  };
});

for (const [, url, title, text] of SEED) {
  await page.evaluate((u, t, x) =>
    window.__call('autorag_ingest_passage', { text: x, source_url: u, title: t }), url, title, text);
  await new Promise((r) => setTimeout(r, 300));
}
await page.evaluate(async () => {
  const ids = (await window.__call('autorag_list_pending', { limit: 100 })).items.map((i) => i.chunk_id);
  return window.__call('autorag_approve_pending', { chunk_ids: ids });
});
await new Promise((r) => setTimeout(r, 800));

const idByUrl = Object.fromEntries(SEED.map(([id, url]) => [url, id]));
const rows = await page.evaluate(async (qs) => {
  const out = [];
  for (const [shape, q, want] of qs) {
    const a = await window.__call('autorag_answer_with_sources', { question: q, k: 4 });
    const c = await window.__call('autorag_check_coverage', { question: q });
    out.push({ shape, q, want, top: a.passages?.[0]?.source_url, conf: a.confidence, verdict: c.verdict });
  }
  return out;
}, QUERIES);
await browser.close();

let rank1 = 0, ranked = 0, verdictOk = 0, judged = 0;
const fails = [];
console.log('\nshape'.padEnd(18), 'top1'.padEnd(11), 'conf'.padEnd(8), 'coverage'.padEnd(13), 'query');
console.log('-'.repeat(92));
for (const r of rows) {
  const got = idByUrl[r.top] ?? '-';
  const uncoverable = r.want === 'NONE';
  if (r.want && !uncoverable) { ranked++; if (got === r.want) rank1++; }

  const ok = uncoverable
    ? r.conf === 'low' || r.verdict === 'not_covered'
    : got === r.want && r.conf !== 'low';
  if (r.want) { judged++; if (ok) verdictOk++; else fails.push(r.q); }

  const mark = !r.want ? ' ' : ok ? '✓' : '✗';
  console.log(r.shape.padEnd(18), got.padEnd(11), String(r.conf).padEnd(8), String(r.verdict).padEnd(13), mark + ' ' + r.q);
}
console.log('-'.repeat(92));
console.log(`top-1 ${rank1}/${ranked} (${(100 * rank1 / ranked).toFixed(0)}%)   ` +
            `usable verdict ${verdictOk}/${judged} (${(100 * verdictOk / judged).toFixed(0)}%)`);
if (fails.length) console.log('failed:', fails.map((f) => `"${f}"`).join(', '));
if (errors.length) console.log('page errors:', errors.slice(0, 3));
process.exit(fails.length === 0 && errors.length === 0 ? 0 : 1);
