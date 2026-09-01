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

  /*
   * The human path, end to end, the way it is actually used: highlight text,
   * click the button that appears, then ask for it back from a different site.
   * No URL is typed anywhere; the source is taken from the tab.
   */
  await page.evaluate(() => {
    const p = document.querySelector('p');
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.click('#autorag-keep-button');
  await page
    .waitForFunction(
      () => document.getElementById('autorag-keep-button')?.textContent?.startsWith('Kept'),
      { timeout: 30_000 },
    )
    .catch(() => {});
  const clicked = await page.evaluate(
    () => document.getElementById('autorag-keep-button')?.textContent ?? '(button gone)',
  );
  log('clicking Keep on a highlight stores it', clicked.startsWith('Kept'), `button read "${clicked}"`);


  // Approve it the way the person would, so recall has something to find.
  const approved = await page.evaluate(async () => {
    const send = (req) =>
      new Promise((res) => chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: '1', request: req }, res));
    return send({ kind: 'stats' });
  }).catch(() => null);
  void approved;

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
  /*
   * The panel's own checks must run in the panel, not in a web page: `chrome.*`
   * does not exist in a page's MAIN world, only in extension contexts and
   * content scripts. Opening sidepanel.html as an ordinary tab gives the real
   * thing an origin puppeteer can drive.
   */
  const swTarget = browser.targets().find((t) => t.url().includes('/background.js'));
  const extId = swTarget ? new URL(swTarget.url()).host : null;
  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1500));

  const read = await panel.evaluate(async () => {
    const send = (req) =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'p', request: req }, res),
      );
    return { stats: await send({ kind: 'stats' }), activity: await send({ kind: 'activity' }) };
  });

  log(
    'the panel can report model state',
    read.stats?.ok === true && read.stats.data.model_ready === true,
    `phase=${read.stats?.data?.model_phase} ready=${read.stats?.data?.model_ready}`,
  );

  const feed = read.activity?.data ?? [];
  log(
    'background work is visible as an activity feed',
    Array.isArray(feed) && feed.length > 0,
    feed.length ? `${feed.length} events, latest: "${feed[0].message}"` : 'no events',
  );

  // Preview and WebMCP status both target "the tab you are looking at". Addressed
  // here by explicit id, since the panel is itself the active tab under puppeteer.
  const pageTargetId = await page.evaluate(() => document.title);
  void pageTargetId;
  const probe = await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://example.com/*' });
    const id = tabs[0]?.id;
    if (!id) return { error: 'example.com tab not found' };
    const preview = await chrome.tabs.sendMessage(id, { type: 'autorag:preview-page' });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'MAIN',
      func: async () => {
        const ctx = document.modelContext;
        if (!ctx?.getTools) return { present: false, tools: [] };
        return { present: true, tools: (await ctx.getTools()).map((t) => t.name) };
      },
    });
    return { preview, webmcp: result };
  });

  log(
    'whole-page capture can be previewed before it is stored',
    typeof probe.preview?.text === 'string' && probe.preview.text.length > 0,
    probe.preview
      ? `${probe.preview.text.split(/\s+/).length} words previewed, nothing stored yet`
      : `no preview (${probe.error ?? 'unknown'})`,
  );

  /*
   * The loop a person actually does: keep something, approve it, ask for it back.
   * Everything before this proved the plumbing; this proves the product.
   */
  const loop = await panel.evaluate(async () => {
    const send = (req) =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'l', request: req }, res),
      );
    const pending = (await send({ kind: 'listPending' })).data;
    if (!pending?.length) return { error: 'nothing staged to approve' };
    await send({ kind: 'approve', chunkIds: pending.map((p) => p.chunk_id) });
    const answer = (await send({ kind: 'answer', question: 'What is example.com reserved for?' })).data;
    return {
      approved: pending.length,
      hits: answer?.hits?.length ?? 0,
      confidence: answer?.confidence,
      cites: answer?.hits?.[0]?.source?.url ?? null,
      snippet: answer?.hits?.[0]?.text?.slice(0, 60) ?? null,
    };
  });
  log(
    'keep → approve → recall returns the passage with its source',
    loop.hits > 0 && !!loop.cites,
    loop.error ?? `${loop.hits} passage(s), confidence ${loop.confidence}, cites ${loop.cites}`,
  );

  const managed = await panel.evaluate(async () => {
    const send = (req) =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'm', request: req }, res),
      );
    const before = (await send({ kind: 'listSources' })).data;
    const id = before[0]?.source_id;
    if (!id) return { error: 'no sources to manage' };
    const staled = (await send({ kind: 'markStale', sourceId: id, stale: true, reason: 'test' })).data;
    const forgot = (await send({ kind: 'forget', sourceId: id })).data;
    const after = (await send({ kind: 'listSources' })).data;
    return { count: before.length, staled, forgot, remaining: after.length };
  });
  log(
    'the corpus can be managed: mark out of date, forget',
    managed.staled?.stale === true && managed.forgot?.chunks_removed >= 1 &&
      managed.remaining === managed.count - 1,
    managed.error ?? `${managed.count} → ${managed.remaining} sources after forgetting one`,
  );

  log(
    'the panel can prove WebMCP is live on the tab',
    probe.webmcp?.present === true &&
      probe.webmcp.tools.filter((t) => t.startsWith('autorag_')).length === 4,
    `${probe.webmcp?.tools?.filter((t) => t.startsWith('autorag_')).length ?? 0} autorag tools readable from the page`,
  );
} catch (err) {
  log('run completed', false, String(err));
} finally {
  const passed = steps.filter((s) => s.ok).length;
  console.log(`\n${passed}/${steps.length} checks passed on ${await browser.version()}`);
  await browser.close();
  process.exit(passed === steps.length ? 0 : 1);
}
