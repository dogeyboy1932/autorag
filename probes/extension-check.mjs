/**
 * Does the extension actually work on a site that has never heard of Autorag?
 *
 *   pnpm ext && node probes/extension-check.mjs [--executable <path>]
 *
 * The claim under test is the one that separates this from "an LLM with a vector
 * database": on an arbitrary third-party page, an agent should discover the
 * person's own curated memory as ordinary WebMCP tools, and a tool call made
 * there should reach a corpus that lives nowhere near that page.
 *
 * Throwaway profile every run; your real profile is never touched.
 */
import puppeteer from 'puppeteer-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../extension/dist');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const steps = [];
const log = (name, ok, note) => {
  steps.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
};

/** Waits until every autorag_* tool has finished registering. */
async function waitForTools(page) {
  await page
    .waitForFunction(
      async () => {
        const ctx = document.modelContext;
        if (!ctx) return false;
        const names = (await ctx.getTools()).map((t) => t.name);
        return names.filter((n) => n.startsWith('autorag_')).length >= 4;
      },
      { timeout: 30_000, polling: 250 },
    )
    .catch(() => {});
}

const browser = await puppeteer.launch({
  executablePath: arg('executable', '/snap/bin/brave'),
  headless: false,
  userDataDir: mkdtempSync(join(tmpdir(), 'autorag-ext-')),
  args: [
    '--no-first-run',
    '--no-default-browser-check',
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
  ],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().includes('[autorag]')) errors.push(m.text());
  });
  // A page with no relationship to this project and no WebMCP of its own.
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  // Registration is sequential and awaited per tool, so the surface fills in over
  // several frames. Sampling the moment modelContext appears reads it half-built.
  await waitForTools(page);

  const surface = await page.evaluate(async () => {
    const ctx = document.modelContext;
    if (!ctx) return { present: false };
    const all = (await ctx.getTools()).map((t) => t.name).sort();
    return { present: true, all, ours: all.filter((n) => n.startsWith('autorag_')) };
  });

  log(
    'a third-party page gains a WebMCP surface it never had',
    surface.present,
    surface.present ? 'document.modelContext installed by the extension' : 'no modelContext',
  );

  if (errors.length) console.log('  registration errors:\n   ' + errors.join('\n   '));

  log(
    "the person's memory tools appear on that page",
    surface.ours?.length === 4 && surface.ours.includes('autorag_recall'),
    surface.ours?.join(', '),
  );

  // @mcp-b/global registers a `page_heading` demo tool of its own on import. It is
  // not ours and an agent should not be offered it on every site the person visits.
  const strays = (surface.all ?? []).filter((n) => !n.startsWith('autorag_'));
  if (strays.length) console.log(`  note: polyfill also registered ${strays.join(', ')}`);

  // A call made on example.com must reach the corpus in the offscreen document.
  const stats = await page.evaluate(async () => {
    const ctx = document.modelContext;
    const tools = await ctx.getTools();
    const tool = tools.find((t) => t.name === 'autorag_memory_stats');
    const raw = await ctx.executeTool(tool, JSON.stringify({}));
    const env = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return JSON.parse(env.content[0].text);
  });
  log(
    'a tool call on that page reaches the extension-owned corpus',
    stats?.ok === true && typeof stats.chunk_count === 'number',
    `chunk_count ${stats?.chunk_count}, model_ready ${stats?.model_ready}`,
  );

  // The human path: select text, get an affordance, no dashboard involved.
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.body);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 500));
  const hasButton = await page.evaluate(() => !!document.getElementById('autorag-keep-button'));
  log('selecting text offers to keep it, in place', hasButton, 'no dashboard, no pasted URL');

  // Fresh profile means a cold 25MB model download. Ingest cannot run until it
  // finishes, so wait rather than recording a failure that is really a timing bug.
  process.stdout.write('  waiting for the embedding model to download…');
  const ready = await page
    .waitForFunction(
      async () => {
        const ctx = document.modelContext;
        const tools = await ctx.getTools();
        const tool = tools.find((t) => t.name === 'autorag_memory_stats');
        if (!tool) return false;
        const raw = await ctx.executeTool(tool, JSON.stringify({}));
        const env = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return JSON.parse(env.content[0].text).model_ready === true;
      },
      { timeout: 90_000, polling: 3000 },
    )
    .then(() => true)
    .catch(() => false);
  console.log(ready ? ' ready' : ' TIMED OUT');
  if (!ready) {
    const why = await page.evaluate(async () => {
      const ctx = document.modelContext;
      const tools = await ctx.getTools();
      const tool = tools.find((t) => t.name === 'autorag_memory_stats');
      const raw = await ctx.executeTool(tool, JSON.stringify({}));
      const env = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return JSON.parse(env.content[0].text);
    });
    console.log(`  phase=${why.model_phase} progress=${why.model_progress} error=${why.model_error}`);
  }

  // And the agent path for capture, which is the same corpus by a different door.
  const kept = await page.evaluate(async () => {
    const ctx = document.modelContext;
    const tools = await ctx.getTools();
    const tool = tools.find((t) => t.name === 'autorag_remember_passage');
    const raw = await ctx.executeTool(
      tool,
      JSON.stringify({
        text: 'Example Domain is reserved by IANA for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.',
        title: 'Example Domain',
      }),
    );
    const env = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return JSON.parse(env.content[0].text);
  });
  log(
    'an agent can deposit from the page it is reading',
    kept?.ok === true && kept.chunk_count >= 1,
    `staged ${kept?.chunk_count} chunk(s) from ${kept?.source_id ? 'example.com' : '?'}`,
  );

  // Cross-site: what was kept on one origin is recallable from another.
  const other = await browser.newPage();
  await other.goto('https://www.iana.org/help/example-domains', { waitUntil: 'domcontentloaded' });
  await waitForTools(other);
  const recalled = await other.evaluate(async () => {
    const ctx = document.modelContext;
    const tools = await ctx.getTools();
    const tool = tools.find((t) => t.name === 'autorag_recall');
    const raw = await ctx.executeTool(tool, JSON.stringify({ question: 'What is example.com for?' }));
    const env = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return JSON.parse(env.content[0].text);
  });
  /*
   * Nothing has been approved, so the honest expected result is zero passages
   * with the call itself succeeding. The claim under test is that the *memory*
   * is reachable from an unrelated origin, not that it answers — approval is the
   * person's job and no probe should forge it.
   */
  log(
    'the memory is reachable from an unrelated site',
    recalled?.ok === true && Array.isArray(recalled.hits),
    `call succeeded from iana.org; ${recalled?.hits?.length ?? 0} passages (nothing approved yet, so 0 is correct)`,
  );
} catch (err) {
  log('run completed', false, String(err));
} finally {
  const passed = steps.filter((s) => s.ok).length;
  console.log(`\n${passed}/${steps.length} checks passed on ${await browser.version()}`);
  await browser.close();
  process.exit(passed === steps.length ? 0 : 1);
}
