/**
 * Retrieval benchmark. Drives the running app through real WebMCP tool calls in
 * headless Chrome — no internal imports, so it measures what an agent measures.
 *
 *   pnpm dev                       # in one terminal
 *   node bench/retrieval.mjs       # in another
 *
 * Reports three numbers, which together define "working" for a retrieval layer
 * that is deliberately not allowed to make judgement calls:
 *
 *   top-1        did the right source rank first
 *   no overclaim did it avoid reporting a strong match for something the corpus
 *                genuinely lacks (false confidence is the dangerous failure)
 *   no withhold  did it always hand back passages, so the agent can judge for
 *                itself rather than being told to give up
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
    out.push({ shape, q, want,
      top: a.passages?.[0]?.source_url,
      conf: a.confidence,
      verdict: c.verdict,
      n: a.passages?.length ?? 0,
      note: a.coverage_note ?? '',
      selfContained: a.match_signals?.query_is_self_contained });
  }
  return out;
}, QUERIES);
await browser.close();

let rank1 = 0, ranked = 0, overclaim = 0, offTopic = 0, withheld = 0;
const fails = [];
console.log('\nshape'.padEnd(18), 'top1'.padEnd(11), 'conf'.padEnd(8), 'coverage'.padEnd(13), 'n', ' query');
console.log('-'.repeat(96));
for (const r of rows) {
  const got = idByUrl[r.top] ?? '-';
  const uncoverable = r.want === 'NONE';

  // A retrieval layer must never leave the agent with nothing to judge.
  if (r.n === 0) { withheld++; fails.push(`${r.q} (withheld passages)`); }

  let mark = ' ';
  if (uncoverable) {
    offTopic++;
    const claimed = r.conf === 'high';
    if (claimed) { overclaim++; fails.push(`${r.q} (claimed strong match)`); }
    mark = claimed ? '✗' : '✓';
  } else if (r.want) {
    ranked++;
    const hit = got === r.want;
    if (hit) rank1++; else fails.push(`${r.q} (ranked ${got}, wanted ${r.want})`);
    mark = hit ? '✓' : '✗';
  }
  console.log(r.shape.padEnd(18), got.padEnd(11), String(r.conf).padEnd(8),
              String(r.verdict).padEnd(13), String(r.n).padEnd(2), mark + ' ' + r.q);
}
console.log('-'.repeat(96));
console.log(`top-1 ${rank1}/${ranked} (${(100 * rank1 / ranked).toFixed(0)}%)   ` +
            `no overclaim ${offTopic - overclaim}/${offTopic}   ` +
            `no withhold ${rows.length - withheld}/${rows.length}`);
if (fails.length) console.log('failed:', fails.join(' | '));
if (errors.length) console.log('page errors:', errors.slice(0, 3));
process.exit(fails.length === 0 && errors.length === 0 ? 0 : 1);
