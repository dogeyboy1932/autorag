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
        return names.filter((n) => n.startsWith('autorag_')).length >= 7;
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
    surface.ours?.length === 7 && surface.ours.includes('autorag_recall'),
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

  /*
   * Chromium drops a suggested key it considers taken — silently: no error, no
   * console warning, the command just comes back with an empty shortcut. Ctrl+Shift+S
   * was refused on Brave for the whole build (Brave's own screenshot tool owns it)
   * while the README, the panel and HUMAN-TASKS all told people to press it. Only a
   * check can catch that class of bug, because nothing else reports it.
   */
  const binds = await panel.evaluate(() => chrome.commands.getAll());
  const unbound = binds.filter((c) => c.name !== '_execute_action' && !c.shortcut);
  log(
    'every keyboard shortcut the manifest asks for is actually assigned',
    unbound.length === 0,
    unbound.length
      ? `${unbound.map((c) => c.name).join(', ')} got no shortcut — the browser refused it`
      : binds
          .filter((c) => c.shortcut)
          .map((c) => `${c.name} ${c.shortcut}`)
          .join(', '),
  );

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

  /*
   * A side panel is resized by the person, constantly, and it is narrow to begin
   * with. Sideways scrolling there is not cosmetic — it hides the buttons.
   *
   * The cause is never the layout: it is one unbroken token, almost always a URL
   * inside a captured passage, which cannot wrap and so sets a min-content width of
   * its own length. Measured before the fix: every card sat at 607px however narrow
   * the panel got. This asserts the fix at widths a person can actually drag to.
   */
  const widths = {};
  for (const w of [420, 340, 280]) {
    await panel.setViewport({ width: w, height: 900 });
    await new Promise((r) => setTimeout(r, 300));
    widths[w] = await panel.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
  }
  await panel.setViewport({ width: 800, height: 900 });
  const overflowing = Object.entries(widths).filter(([, v]) => v.scroll > v.client + 1);
  log(
    'the panel fits its width instead of scrolling sideways',
    overflowing.length === 0,
    overflowing.length
      ? overflowing.map(([w, v]) => `${w}px: content ${v.scroll} > panel ${v.client}`).join('; ')
      : Object.entries(widths).map(([w, v]) => `${w}→${v.scroll}`).join(', '),
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

  /*
   * Keeping an image. Autorag indexes text, so what is stored is the page's own
   * description of the picture with the image URL as provenance — and the check has
   * to prove both halves of that bargain: a described image becomes findable *by its
   * description*, and an undescribed one is refused rather than stored as a URL no
   * search can ever match. The second half is the honest one.
   */
  const images = await page.evaluate(() => {
    const described = document.createElement('img');
    described.src = 'https://example.com/chart.png';
    described.alt = 'Quarterly rainfall in Reykjavik, millimetres per month';
    const fig = document.createElement('figure');
    fig.appendChild(described);
    const cap = document.createElement('figcaption');
    cap.textContent = 'Rainfall peaks sharply in October and stays high through winter.';
    fig.appendChild(cap);
    document.body.appendChild(fig);

    const bare = document.createElement('img');
    bare.src = 'https://example.com/spacer.gif';
    document.body.appendChild(bare);
    return true;
  });
  void images;
  await page.evaluate(() => {
    chrome.runtime.onMessage.addListener(() => {});
  }).catch(() => {});

  const imageKeep = await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://example.com/*' });
    const id = tabs[0]?.id;
    if (!id) return { error: 'no example.com tab' };
    // Exactly what the context-menu handler sends.
    await chrome.tabs.sendMessage(id, {
      type: 'autorag:capture-image',
      srcUrl: 'https://example.com/chart.png',
    });
    await new Promise((r) => setTimeout(r, 4000));
    const send = (req) =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'i', request: req }, res),
      );
    const staged = ((await send({ kind: 'listPending' })).data ?? []).find((p) =>
      p.text.includes('Reykjavik'),
    );
    if (staged) await send({ kind: 'approve', chunkIds: [staged.chunk_id] });
    const found = (await send({ kind: 'answer', question: 'When is rainfall highest in Reykjavik?' })).data;

    // And the undescribed one, which must be refused.
    await chrome.tabs.sendMessage(id, {
      type: 'autorag:capture-image',
      srcUrl: 'https://example.com/spacer.gif',
    });
    await new Promise((r) => setTimeout(r, 2500));
    const after = (await send({ kind: 'listPending' })).data ?? [];
    return {
      stagedText: staged?.text ?? null,
      hits: found?.hits?.length ?? 0,
      cites: found?.hits?.[0]?.source?.url ?? null,
      bareStored: after.some((p) => p.text.includes('spacer.gif')),
    };
  });
  log(
    'an image is kept by its description, and cites the image itself',
    !!imageKeep.stagedText?.includes('Rainfall peaks') && imageKeep.hits > 0 &&
      imageKeep.cites === 'https://example.com/chart.png',
    imageKeep.error ?? `recall found it via the caption; cites ${imageKeep.cites}`,
  );
  log(
    'an image with nothing said about it is refused, not stored as a bare URL',
    imageKeep.bareStored === false,
    imageKeep.bareStored ? 'a URL with no description reached the queue' : 'nothing staged for it',
  );

  /*
   * Revising a staged passage before deciding on it. The assertion that matters is
   * not that the text changed — it is that the *embedding* changed with it. Storing
   * new text beside the old vector produces a passage that reads one way and
   * retrieves another, and nothing surfaces that until a search quietly stops
   * working. So: edit a staged passage to say something entirely different, then
   * search for the new wording and require it back.
   */
  const revised = await panel.evaluate(async () => {
    const send = (req) =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'e', request: req }, res),
      );
    await send({
      kind: 'ingest',
      text: 'A passage about tidal turbine maintenance schedules in the North Sea, kept so it can be edited.',
      sourceUrl: 'https://example.com/editable',
      title: 'Editable',
    });
    const staged = ((await send({ kind: 'listPending' })).data ?? []).find((p) =>
      p.text.includes('tidal turbine'),
    );
    if (!staged) return { error: 'nothing staged to edit' };

    const out = await send({
      kind: 'revisePending',
      chunkId: staged.chunk_id,
      text: 'Espresso extraction time for a double shot is twenty five to thirty seconds at nine bars of pressure.',
      note: 'Checked against the roaster guide.',
    });
    await send({ kind: 'approve', chunkIds: [staged.chunk_id] });
    const found = (await send({ kind: 'answer', question: 'How long should an espresso shot take?' })).data;
    return {
      ok: out?.ok,
      note: out?.data?.note,
      hit: found?.hits?.[0]?.chunk?.text ?? '',
      keptNote: found?.hits?.[0]?.chunk?.note ?? null,
    };
  });
  log(
    'an edited passage is re-embedded, not just re-worded',
    revised.ok === true && revised.hit.includes('Espresso') && revised.note === 'Checked against the roaster guide.',
    revised.error ?? `search for the new wording returns it; note "${revised.keptNote}" travels with the hit`,
  );

  // Discarding without writing an essay about it.
  const bareDiscard = await panel.evaluate(async () => {
    const send = (req) =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'd', request: req }, res),
      );
    await send({
      kind: 'ingest',
      text: 'A thoroughly unremarkable paragraph that exists only to be thrown away without explanation.',
      sourceUrl: 'https://example.com/junk',
      title: 'Junk',
    });
    const staged = ((await send({ kind: 'listPending' })).data ?? []).find((p) =>
      p.text.includes('unremarkable'),
    );
    if (!staged) return { error: 'nothing staged to discard' };
    const out = await send({ kind: 'reject', chunkIds: [staged.chunk_id] });
    const left = ((await send({ kind: 'listPending' })).data ?? []).some(
      (p) => p.chunk_id === staged.chunk_id,
    );
    return { rejected: out?.data?.rejected?.length ?? 0, stillPending: left };
  });
  log(
    'something can be discarded without giving a reason',
    bareDiscard.rejected === 1 && bareDiscard.stillPending === false,
    bareDiscard.error ?? 'discarded with an empty reason; it left the queue',
  );

  /*
   * The curation loop, driven entirely from a webpage's tool surface — the door an
   * agent actually has. Screening deliberately over-flags, which is only affordable
   * if something triages the nominations before they reach a person; that triage is
   * what these three tools are for.
   *
   * Both halves are asserted, per HANDOFF rule 6: the ruling must come back from the
   * call *and* be sitting on the queue afterwards, where the human will read it.
   * A verdict that returns ok and lands nowhere is the exact shape of D12.
   */
  const call = (target) => async (name, args) =>
    target.evaluate(
      async (toolName, payload) => {
        const ctx = document.modelContext;
        const tools = await ctx.getTools();
        const tool = tools.find((t) => t.name === toolName);
        if (!tool) return { ok: false, error: { message: `${toolName} is not registered` } };
        const raw = await ctx.executeTool(tool, JSON.stringify(payload));
        const env = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return JSON.parse(env.content[0].text);
      },
      name,
      args,
    );
  const onExample = call(page);
  const onIana = call(other);

  // A figure to disagree with, approved so it counts as established.
  await onExample('autorag_remember_passage', {
    text: 'The IANA special-use domain registry lists 3 names reserved for documentation, and has been stable since 1999. Anyone may use them in written examples without asking permission.',
    title: 'Special-use domains',
  });
  await panel.evaluate(async () => {
    const send = (req) =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'c', request: req }, res),
      );
    const staged = (await send({ kind: 'listPending' })).data ?? [];
    if (staged.length) await send({ kind: 'approve', chunkIds: staged.map((p) => p.chunk_id) });
  });

  // The same claim, different numbers, from a different site — what a person
  // reading two sources on one subject actually produces.
  await onIana('autorag_remember_passage', {
    text: 'The IANA special-use domain registry lists 5 names reserved for documentation, and has been stable since 2013. Anyone may use them in written examples without asking permission.',
    title: 'Special-use domains (revised)',
  });

  const queue = await onIana('autorag_list_pending', { only_conflicted: true });
  const flagged = queue?.pending?.[0];
  const conflict = flagged?.conflicts?.[0];
  log(
    'an agent can read the review queue, with both sides of a flagged pair',
    queue?.ok === true && !!conflict?.against_chunk_id && !!conflict?.against_text,
    conflict
      ? `${queue.total_count} flagged; "${conflict.kind}" carrying ${conflict.against_text.length} chars of the passage it collides with`
      : `no flagged passage returned (${queue?.error?.message ?? 'queue empty'})`,
  );

  const ruled = conflict
    ? await onIana('autorag_adjudicate_conflict', {
        chunk_id: flagged.chunk_id,
        against_chunk_id: conflict.against_chunk_id,
        ruling: 'keep_new',
        reasoning:
          'Both describe the same registry; the 5 names and 2013 date supersede the older 3 and 1999.',
      })
    : { ok: false, error: { message: 'nothing was flagged to rule on' } };

  const afterRuling = await onIana('autorag_list_pending', { only_conflicted: true });
  const landed = afterRuling?.pending
    ?.find((p) => p.chunk_id === flagged?.chunk_id)
    ?.conflicts?.find((c) => c.agent_verdict);
  log(
    "an agent's ruling reaches the queue the human reads",
    ruled?.ok === true && landed?.agent_verdict?.ruling === 'keep_new',
    landed?.agent_verdict
      ? `verdict "${landed.agent_verdict.ruling}" is on the queue: "${landed.agent_verdict.reasoning.slice(0, 60)}…"`
      : `returned ok=${ruled?.ok} but nothing is on the queue (${ruled?.error?.message ?? ''})`,
  );

  /*
   * And the half that actually matters to a person: the ruling has to be *on screen*
   * in the review queue, not merely in storage. A verdict nobody reads is the same
   * failure as a tool result nobody receives — D12 wearing a different hat.
   */
  await panel.reload({ waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1500));
  const shown = await panel.evaluate(() => {
    const el = document.querySelector('.verdict');
    return el ? el.textContent : null;
  });
  log(
    'the person sees that ruling in their review queue',
    typeof shown === 'string' && shown.includes('agent:') && shown.includes('You still decide'),
    shown ? `panel shows "${shown.slice(0, 70)}…"` : 'no verdict rendered in the panel',
  );

  // Approving is deliberately not on the agent's menu; the panel is the only door.
  const noApprove = await onIana('autorag_approve_pending', { chunk_ids: [flagged?.chunk_id] });
  log(
    'the agent cannot approve or discard — that stays with the person',
    noApprove?.ok === false,
    noApprove?.error?.message ?? 'an approval tool was reachable from the page',
  );

  const covered = await onIana('autorag_list_sources', {});
  log(
    'an agent can see what the memory already covers',
    covered?.ok === true && covered.total_count >= 1 && !!covered.sources?.[0]?.url,
    covered?.ok
      ? `${covered.total_count} source(s), first: ${covered.sources[0].title}`
      : (covered?.error?.message ?? 'no sources returned'),
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
      probe.webmcp.tools.filter((t) => t.startsWith('autorag_')).length === 7,
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
