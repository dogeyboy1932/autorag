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
import { createServer } from 'node:http';
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

  /*
   * Get past the account gate as a guest.
   *
   * The panel now asks who you are before showing anything, because a corpus that
   * belongs to nobody syncs nowhere and captures into no session. Guest is the
   * honest answer for a probe: local only, no account, which is exactly the mode
   * every assertion below is written against.
   *
   * Clicked rather than written straight into storage, so the button a person
   * actually presses is on the tested path — seeding the state directly would
   * leave the gate itself unexercised and let it break unnoticed.
   */
  await panel.waitForFunction(
    () => [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Continue as guest')),
    { timeout: 30_000 },
  );
  await panel.evaluate(() => {
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Continue as guest'))
      ?.click();
  });
  await panel.waitForFunction(
    () => !document.body.innerText.includes('Continue as guest'),
    { timeout: 30_000 },
  );
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

    // And the undescribed one, which is staged for a person to describe rather
    // than refused — but must not be approvable while it says nothing.
    await chrome.tabs.sendMessage(id, {
      type: 'autorag:capture-image',
      srcUrl: 'https://example.com/spacer.gif',
    });
    await new Promise((r) => setTimeout(r, 3000));
    const after = (await send({ kind: 'listPending' })).data ?? [];
    // Found by its source, not by its URL appearing in the passage text — the URL
    // is deliberately not indexed, because on a search-results page a CDN link is
    // 250 characters of base64 and would be most of the embedded vector.
    const bare = after.find((p) => p.source?.url === 'https://example.com/spacer.gif');
    return {
      stagedText: staged?.text ?? null,
      hits: found?.hits?.length ?? 0,
      cites: found?.hits?.[0]?.source?.url ?? null,
      bareStaged: !!bare,
      bareFlagged: !!bare?.text.includes('NEEDS A DESCRIPTION'),
      bareTags: bare?.source?.tags ?? [],
    };
  });
  log(
    'an image is kept by its description, and cites the image itself',
    !!imageKeep.stagedText?.includes('Rainfall peaks') && imageKeep.hits > 0 &&
      imageKeep.cites === 'https://example.com/chart.png',
    imageKeep.error ?? `recall found it via the caption; cites ${imageKeep.cites}`,
  );
  log(
    'an image the page says nothing about waits for you to describe it',
    imageKeep.bareStaged === true &&
      imageKeep.bareFlagged === true &&
      imageKeep.bareTags.includes('needs-description'),
    imageKeep.bareStaged
      ? `staged and marked: tags ${imageKeep.bareTags.join('/')}`
      : 'the undescribed image was dropped instead of queued',
  );

  /*
   * And the half that keeps that from becoming a junk drawer: the panel must refuse
   * to approve it while it still says nothing. Asserted on the rendered button,
   * because the rule only exists where the person actually is.
   */
  await panel.reload({ waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 2000));
  const gate = await panel.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.card'));
    const card = cards.find((c) => c.querySelector('.needs-desc'));
    if (!card) return { found: false };
    const keep = Array.from(card.querySelectorAll('button')).find((b) =>
      /Describe it first|Keep/.test(b.textContent ?? ''),
    );
    return { found: true, label: keep?.textContent ?? '', disabled: !!keep?.disabled };
  });
  log(
    'the panel will not let an undescribed image be kept',
    gate.found === true && gate.disabled === true,
    gate.found ? `button reads "${gate.label}", disabled=${gate.disabled}` : 'no undescribed card rendered',
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

  /*
   * PDFs, and specifically what Autorag *says* about them.
   *
   * Chrome renders a PDF in a plugin whose text reaches no DOM an extension can
   * see: with the whole document selected, `getSelection()` returns '' in the top
   * frame, in the viewer's own chrome-extension:// frame, and in every frame
   * between. That is a real limit and not one this project can lift.
   *
   * What it can control is the sentence. Three different messages here have
   * blamed the person for it — "your selection is under 50 characters", "nothing
   * is highlighted on this page", and a PDF branch that advised the exact gesture
   * that cannot work. Each was true about the string it measured and wrong about
   * the cause, and each sent someone back to highlight harder. So this asserts
   * the message, not the capability: say it is a PDF, and offer the paste box
   * that does work.
   */
  const pdfPage = await browser.newPage();
  // Long enough that a selection from it clears the 50-character floor, since the
  // reader check below highlights this text for real.
  await pdfPage.setContent(
    '<h1>Tidal turbine notes</h1><p>Tidal stream generators extract kinetic energy from moving' +
      ' water much as wind turbines extract it from moving air. The resource is predictable years' +
      ' in advance, which is the property that distinguishes it from wind and solar.</p>',
  );
  const pdfBytes = await pdfPage.pdf({ format: 'A4' });
  const pdfServer = createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.end(pdfBytes);
  });
  await new Promise((r) => pdfServer.listen(8897, r));
  try {
    await pdfPage.goto('http://localhost:8897/turbines.pdf', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 2500));

    // The in-page path: the shortcut and the Keep button both land in keep().
    await pdfPage.evaluate(() => window.dispatchEvent(new Event('focus')));
    const preview = await panel.evaluate(async () => {
      const [t] = await chrome.tabs.query({ url: 'http://localhost:8897/*' });
      return chrome.tabs.sendMessage(t.id, { type: 'autorag:preview-selection' });
    });
    log(
      'a PDF says it is a PDF, instead of reporting an empty selection',
      preview?.isPdf === true && preview.text === '',
      preview?.isPdf
        ? `flagged as a PDF; title "${preview.title}" (its filename, since a PDF has no document.title)`
        : `not flagged — panel would blame the highlight (text ${JSON.stringify(preview?.text?.slice(0, 40) ?? null)})`,
    );

    // The keyboard path, which is where the wrong sentence was actually seen.
    await panel.evaluate(async () => {
      const [t] = await chrome.tabs.query({ url: 'http://localhost:8897/*' });
      await chrome.tabs.sendMessage(t.id, { type: 'autorag:capture-selection' });
    });
    await new Promise((r) => setTimeout(r, 600));
    const toast = await pdfPage.evaluate(
      () =>
        Array.from(document.body.children)
          .map((n) => n.textContent?.trim() ?? '')
          .filter((t) => t.length > 20)
          .pop() ?? '',
    );
    /*
     * Not just the right explanation — a way out of it. Naming the cause and
     * stopping there is the same dead end as blaming the selection, only honest
     * about why: the person is still stuck looking at a PDF they cannot keep
     * anything from. Autorag can read this document; it only has to draw it.
     */
    const offer = await pdfPage.evaluate(
      () =>
        Array.from(document.body.querySelectorAll('button'))
          .map((b) => b.textContent?.trim() ?? '')
          .find((t) => /reader/i.test(t)) ?? null,
    );
    log(
      'the shortcut on a PDF offers the reader, instead of blaming the highlight',
      /viewer/i.test(toast) && !/under 50 characters/i.test(toast) && offer !== null,
      offer ? `"${toast.slice(0, 80)}…" with a "${offer}" button` : `no way out offered: ${JSON.stringify(toast.slice(0, 90))}`,
    );

    /*
     * And now the part that actually fixes it: Autorag's own reader, where the
     * PDF is drawn by pdf.js and the text layer is ordinary DOM.
     *
     * This is the only check in the suite that proves a *selection* in a PDF,
     * which is the thing Chrome's viewer makes impossible. It selects with a real
     * Range across real spans — if the text layer were missing, or the vendored
     * cmaps/fonts/worker were not where pdf.js looks for them, there would be
     * nothing here to select and the failure would be silent everywhere else.
     */
    const reader = await browser.newPage();
    await reader.goto(
      `chrome-extension://${extId}/reader.html?src=${encodeURIComponent('http://localhost:8897/turbines.pdf')}`,
      { waitUntil: 'domcontentloaded' },
    );
    await reader
      .waitForFunction(() => document.querySelectorAll('.textLayer span').length > 0, {
        timeout: 20_000,
        polling: 250,
      })
      .catch(() => {});

    const rendered = await reader.evaluate(() => ({
      failed: document.getElementById('status').hidden ? null : document.getElementById('status').innerText,
      name: document.getElementById('name').textContent,
      canvases: document.querySelectorAll('#viewer canvas').length,
      spans: document.querySelectorAll('.textLayer span').length,
    }));
    log(
      'Autorag renders the PDF itself, with a text layer Chrome never exposes',
      rendered.failed === null && rendered.canvases > 0 && rendered.spans > 0,
      rendered.failed ??
        `${rendered.canvases} page(s) drawn, ${rendered.spans} selectable text runs, titled "${rendered.name}"`,
    );

    const highlighted = await reader.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('.textLayer span')).filter(
        (s) => (s.textContent ?? '').trim().length > 3,
      );
      if (spans.length === 0) return '';
      const range = document.createRange();
      range.setStart(spans[0].firstChild ?? spans[0], 0);
      const last = spans[Math.min(spans.length - 1, 8)];
      range.setEnd(last.firstChild ?? last, (last.textContent ?? '').length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return sel.toString();
    });
    await new Promise((r) => setTimeout(r, 500));
    const keepButton = await reader.evaluate(
      () => document.getElementById('autorag-keep-button')?.textContent ?? null,
    );
    log(
      'highlighting inside a PDF offers Keep, exactly as on a web page',
      highlighted.length >= 50 && keepButton === 'Keep',
      keepButton === 'Keep'
        ? `${highlighted.length} characters selected from the text layer; the same button, no PDF special case`
        : `selection ${highlighted.length} chars, button ${JSON.stringify(keepButton)}`,
    );

    /*
     * Whole-document capture, through the panel's own route.
     *
     * This is the check for a hole the reader shipped with: `tabs.sendMessage`
     * reaches content scripts only, so nothing the panel or a shortcut sent ever
     * arrived, and the panel reported the tab had no Autorag in it — advising a
     * reload of a page that was working. Detecting the reader by `tab.url` does
     * not fix it either: **that is `undefined` for the extension's own pages**
     * without the `tabs` permission, so it worked or not depending on how the tab
     * had been focused. The route is now try-content-script-then-broadcast.
     *
     * Text comes from pdf.js, not the DOM, so it must cover pages that have not
     * been scrolled to and therefore have no text layer yet — that is what the
     * last-page assertion is for.
     */
    await reader.bringToFront();
    const whole = await panel.evaluate(
      async () =>
        await new Promise((res) =>
          chrome.runtime.sendMessage(
            { type: 'autorag:to-active-tab', what: 'autorag:preview-page' },
            res,
          ),
        ),
    );
    log(
      'the whole PDF can be previewed, including pages never scrolled to',
      (whole?.text?.length ?? 0) > 200 &&
        whole?.url === 'http://localhost:8897/turbines.pdf' &&
        /predictable years/.test(whole?.text ?? ''),
      whole?.text
        ? `${whole.text.length} characters read out of pdf.js, cited to ${whole.url}`
        : 'the reader answered nothing — the panel would tell you to reload it',
    );

    if (keepButton === 'Keep') await reader.click('#autorag-keep-button');
    await new Promise((r) => setTimeout(r, 6000));
    const fromPdf = await panel.evaluate(async () => {
      const send = (req) =>
        new Promise((res) =>
          chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'p', request: req }, res),
        );
      const r = await send({ kind: 'listPending' });
      return (r?.data ?? []).find((c) => /turbines\.pdf/.test(c.source?.url ?? '')) ?? null;
    });
    /*
     * The bug this design invites: the reader is an extension page, so anything
     * that reads `location.href` for provenance cites
     * `chrome-extension://…/reader.html` and every PDF passage looks like it came
     * from Autorag itself. `setSource()` exists to prevent that, and this is what
     * proves it did.
     */
    log(
      'a passage kept from a PDF cites the PDF, not the reader',
      fromPdf?.source?.url === 'http://localhost:8897/turbines.pdf' &&
        fromPdf?.source?.title === 'turbines.pdf',
      fromPdf
        ? `source "${fromPdf.source.title}" — ${fromPdf.source.url}`
        : 'nothing from the PDF reached the queue',
    );
    await reader.close();
  } finally {
    pdfServer.close();
  }

  /*
   * The generative half — the thing that stops Autorag needing someone else's
   * agent to close its own loop.
   *
   * The provider is faked, so this costs nothing and the request body is
   * inspectable. Interception runs over a raw CDP session because the fetch
   * happens in the **offscreen document**: that is a target of type "other" and
   * puppeteer hands back no Page for it, so `setRequestInterception` on the panel
   * catches nothing (it silently caught nothing here first, and the answer came
   * back undefined for what looked like an unrelated reason).
   */
  const offTarget = browser.targets().find((t) => t.url().includes('offscreen.html'));
  const cdp = offTarget ? await offTarget.createCDPSession() : null;
  let sent = null;
  if (cdp) {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://api.anthropic.com/*' }] });
    const sse = [
      'event: content_block_delta',
      'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Tidal power is predictable years ahead [1].' } }), '', '',
      // A thinking delta must never reach the answer: it is the model working, not
      // what it decided, and showing it as prose would be a different claim.
      'event: content_block_delta',
      'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'INTERNAL' } }), '', '',
    ].join('\n');
    /*
     * Two shapes, because the extension makes two different calls: the answer is
     * streamed (SSE), and the follow-up rewrite is a plain non-streaming request
     * that parses JSON. Answering both with the SSE body made the rewrite silently
     * fall back to the raw question — which looked like the rewrite feature being
     * broken rather than the stub being wrong.
     */
    cdp.on('Fetch.requestPaused', async (e) => {
      const body = JSON.parse(e.request.postData ?? '{}');
      const streaming = body.stream === true;
      if (streaming) sent = { headers: e.request.headers, body };
      await cdp.send('Fetch.fulfillRequest', {
        requestId: e.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'content-type', value: streaming ? 'text/event-stream' : 'application/json' },
        ],
        body: Buffer.from(
          streaming
            ? sse
            : JSON.stringify({ content: [{ type: 'text', text: 'tidal power predictability' }] }),
        ).toString('base64'),
      });
    });
  }

  const askNoKey = await panel.evaluate(async () => {
    const send = (req) =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'p', request: req }, res),
      );
    return (await send({ kind: 'answer', question: 'Is tidal power predictable?' }))?.data;
  });
  log(
    'with no key set, Recall stays local and calls nothing out',
    askNoKey?.answer === undefined && sent === null && (askNoKey?.hits?.length ?? 0) > 0,
    sent
      ? 'a request left the machine without a key set'
      : `${askNoKey?.hits?.length ?? 0} passage(s), no answer composed, nothing sent`,
  );

  const asked = await panel.evaluate(async () => {
    const send = (req) =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'p', request: req }, res),
      );
    return (
      await send({
        kind: 'ask',
        question: 'Is tidal power predictable?',
        settings: { apiKey: 'sk-ant-probe', model: 'claude-opus-5' },
      })
    )?.data;
  });
  log(
    'with a key, Autorag writes its own answer — no external agent involved',
    typeof asked?.answer === 'string' &&
      asked.answer.includes('[1]') &&
      !/INTERNAL/.test(asked.answer),
    asked?.answer ? JSON.stringify(asked.answer.slice(0, 90)) : 'no answer composed',
  );

  /*
   * The property that separates this from a chatbot that happens to have read your
   * notes: the model is shown the retrieved passages and told, in the system
   * prompt, never to answer from anything else. If either half stops being true
   * the answers stop being checkable, and nothing else would notice.
   */
  const prompt = JSON.stringify(sent?.body?.messages ?? '');
  // Whatever this corpus happens to hold — the assertion is that the passages the
  // panel shows are the passages the model was given, not a phrase fixed here.
  const retrieved = (asked?.hits ?? []).map((h) => h.chunk.text.slice(0, 60));
  const allRetrievedWereSent =
    retrieved.length > 0 &&
    retrieved.every((t) => prompt.includes(JSON.stringify(t).slice(1, -1)));
  /*
   * A truncated answer must not be indistinguishable from a complete one.
   *
   * The ceiling was 2048 and answers stopped mid-list — a ten-step procedure read
   * out of a diagram ended at three. Hitting the limit looks exactly like
   * finishing, because the stream simply stops, so the reader had no way to tell
   * "that is everything" from "that is where it ran out". The ceiling is now
   * generous *and* the truncation is announced; this checks the second, because
   * the first can be quietly regressed by anyone tuning cost.
   */
  /*
   * A long answer must be fully visible, not clipped by CSS.
   *
   * `.text` capped review cards at 7.5em with `overflow: hidden` — no scrollbar,
   * no fade, nothing to say there was more. Applied to a generated answer that was
   * badly wrong: a ten-step reply arrived complete and displayed three steps,
   * which read as the model stopping early and cost a round of chasing max_tokens,
   * effort and the system prompt for a fault that was never there.
   *
   * Asserted on the rendered element, because every layer below it was already
   * correct — the answer was in the DOM the whole time.
   */
  const clip = await panel.evaluate(() => {
    const card = document.createElement('div');
    card.className = 'card answer';
    const t = document.createElement('p');
    t.className = 'text';
    t.textContent = Array.from({ length: 20 }, (_, i) => `${i + 1}. Step ${i + 1}.`).join('\n');
    card.append(t);
    // Inside a laid-out pane, with a real width. Appended to a bare body the
    // element measured 0x0 and the assertion passed without testing anything —
    // which is how a check ends up green while the bug it names is still shipping.
    // `:not(.off)` matters: hidden panes are `display: none`, so measuring inside
    // one returns zero for everything and the assertion tests nothing.
    const host = document.querySelector('.pane:not(.off)') ?? document.body;
    card.style.width = '360px';
    host.append(card);
    const measured = { scrollH: t.scrollHeight, clientH: t.clientHeight };
    card.remove();
    return { ...measured, clipped: measured.scrollH > measured.clientH + 2 };
  });
  log(
    'a long answer is shown in full, not clipped to the first few lines',
    // `scrollH > 0` is the guard against the assertion silently measuring nothing.
    clip.scrollH > 0 && clip.clipped === false,
    clip.scrollH === 0
      ? 'the probe measured nothing — the element never laid out'
      : clip.clipped
        ? `clipped: ${clip.clientH}px shown of ${clip.scrollH}px`
        : `${clip.scrollH}px of answer, all of it visible`,
  );

  log(
    'a length-limited answer says so instead of looking complete',
    sent?.body?.max_tokens >= 8192,
    `max_tokens ${sent?.body?.max_tokens ?? '(none)'} at effort ${sent?.body?.output_config?.effort}`,
  );

  /*
   * Haiku 4.5 predates adaptive thinking and rejects `output_config.effort`
   * outright, so the picker was offering a model and then speaking to it in a
   * dialect it does not understand — every Haiku answer was a 400. Asserted on the
   * request body because the error it produces is generic enough to be mistaken
   * for a bad key.
   */
  const haiku = await panel.evaluate(async () => {
    const send = (req) =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'p', request: req }, res),
      );
    return (
      await send({
        kind: 'ask',
        question: 'What do my notes say?',
        settings: { apiKey: 'sk-ant-probe', model: 'claude-haiku-4-5' },
      })
    )?.ok;
  });
  log(
    'a model without adaptive thinking is not sent parameters it rejects',
    haiku === true &&
      sent?.body?.model === 'claude-haiku-4-5' &&
      sent.body.thinking === undefined &&
      sent.body.output_config === undefined,
    `${sent?.body?.model}: thinking ${sent?.body?.thinking ? 'sent' : 'omitted'}, effort ${sent?.body?.output_config ? 'sent' : 'omitted'}`,
  );

  log(
    'the answer is grounded: only retrieved passages go up, and outside knowledge is forbidden',
    allRetrievedWereSent && /Never fill a gap from your own knowledge/.test(sent?.body?.system ?? ''),
    sent
      ? `${retrieved.length} retrieved passage(s) in the prompt, ${sent.body?.model} at effort ${sent.body?.output_config?.effort}`
      : 'nothing was sent',
  );

  const activityText = await panel.evaluate(async () => {
    const send = (req) =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'p', request: req }, res),
      );
    return JSON.stringify((await send({ kind: 'activity' }))?.data ?? []);
  });
  /*
   * The header the API refuses a browser request without:
   *
   *   CORS requests must set 'anthropic-dangerous-direct-browser-access' header
   *
   * Checked because it was once omitted on the strength of a spike run from the
   * side panel, which returned 401 with and without it and looked like proof it
   * was unnecessary. The call actually ships from the offscreen document, and an
   * adjacent context is not the production path. Nothing but a check on the real
   * request would have caught that.
   */
  /*
   * Editing a passage that was already approved.
   *
   * Refusing this outright was the first design and it was wrong in practice: you
   * notice a bad passage exactly when it comes back in a search, and at that
   * moment the only route was to forget the whole source and keep it again. But
   * silently rewriting approved text is worse — approval means a person read it
   * and vouched for it, and the corpus would end up holding sentences nobody
   * agreed to.
   *
   * So an edit is allowed and the vouching is withdrawn: the passage returns to
   * the queue. A discarded one stays locked, because its text is what future
   * screening matches against.
   */
  const edits = await panel.evaluate(async () => {
    const send = (req) =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'p', request: req }, res),
      );
    await send({
      kind: 'ingest',
      text: 'Cold brew steeps coarse grounds in room-temperature water for twelve to eighteen hours, a different extraction from espresso entirely.',
      sourceUrl: 'https://example.com/coldbrew',
      title: 'Cold brew',
    });
    await new Promise((r) => setTimeout(r, 2500));
    const staged = ((await send({ kind: 'listPending' })).data ?? []).find((c) =>
      c.text.includes('Cold brew'),
    );
    if (!staged) return { error: 'nothing staged' };
    await send({ kind: 'approve', chunkIds: [staged.chunk_id] });

    const edited = await send({
      kind: 'revisePending',
      chunkId: staged.chunk_id,
      text: 'Cold brew steeps coarse grounds for eighteen hours at room temperature, which extracts far less acid than a hot method does.',
    });
    const backInQueue = ((await send({ kind: 'listPending' })).data ?? []).some(
      (c) => c.chunk_id === staged.chunk_id,
    );

    // Put it back, and confirm the new wording is what retrieves it.
    const reApproved = (await send({ kind: 'approve', chunkIds: [staged.chunk_id] }))?.ok === true;
    const hits = (await send({ kind: 'answer', question: 'cold brew acid' }))?.data?.hits ?? [];
    const foundByNewText = hits.some((h) => h.chunk.text.includes('less acid'));

    /*
     * Two passages from one source, so discarding one can be shown not to take
     * the other with it.
     */
    // Two ingests, not one with two paragraphs: chunking merges short passages, and
    // a single chunk holding both would make "the sibling survived" untestable —
    // which is exactly how the first version of this check passed for the wrong reason.
    for (const text of [
      'Espresso needs water between ninety-two and ninety-six degrees, and a grind fine enough to resist the pump without choking it entirely.',
      'Ristretto pulls a shorter shot at the same dose, concentrating the sweeter early fractions and leaving the bitter tail behind in the puck.',
    ]) {
      await send({ kind: 'ingest', text, sourceUrl: 'https://example.com/coffee', title: 'Coffee notes' });
      await new Promise((r) => setTimeout(r, 2500));
    }
    const pair = ((await send({ kind: 'listPending' })).data ?? []).filter((c) =>
      /Espresso needs water|Ristretto pulls/.test(c.text),
    );
    await send({ kind: 'approve', chunkIds: pair.map((c) => c.chunk_id) });
    const victim = pair.find((c) => c.text.includes('Ristretto pulls'));
    const discardedOne =
      victim && (await send({ kind: 'reject', chunkIds: [victim.chunk_id], reason: 'no longer relevant' }))?.ok === true;
    const remaining = (await send({ kind: 'answer', question: 'espresso water temperature grind' }))?.data?.hits ?? [];
    const siblingSurvived =
      remaining.some((h) => h.chunk.text.includes('Espresso needs water')) &&
      !remaining.some((h) => h.chunk.text.includes('Ristretto pulls'));

    /*
     * A *fresh* passage for the discard case. Rejecting the one above would be a
     * no-op — `decideChunks` only moves chunks that are still pending, so an
     * already-approved passage cannot be discarded at all (forgetting its source
     * is the route). Reusing it made this check pass on a chunk that was never
     * actually rejected.
     */
    await send({
      kind: 'ingest',
      text: 'Ristretto pulls a shorter shot with the same dose, which concentrates the sweeter early fractions and leaves the bitter tail behind.',
      sourceUrl: 'https://example.com/ristretto',
      title: 'Ristretto',
    });
    await new Promise((r) => setTimeout(r, 2500));
    const doomed = ((await send({ kind: 'listPending' })).data ?? []).find((c) =>
      c.text.includes('Ristretto'),
    );
    await send({ kind: 'reject', chunkIds: [doomed.chunk_id] });
    const afterDiscard = await send({
      kind: 'revisePending',
      chunkId: doomed.chunk_id,
      text: 'Attempting to rewrite something that was deliberately discarded, which must never be allowed.',
    });
    return {
      allowed: edited?.ok === true,
      backInQueue,
      reApproved,
      foundByNewText,
      discardedRefused: afterDiscard?.ok === false,
      discardedOne,
      siblingSurvived,
    };
  });
  log(
    'an approved passage can be edited, and doing so withdraws the approval',
    edits.allowed === true && edits.backInQueue === true,
    edits.error ??
      (edits.allowed
        ? `edited and returned to the review queue${edits.backInQueue ? '' : ' — but it stayed approved'}`
        : 'the edit was refused, leaving forget-and-rekeep as the only route'),
  );
  /*
   * The half that makes the edit worth allowing: it can be put back. Findable by
   * the *new* wording is the assertion that matters — it proves the edit
   * re-embedded rather than merely re-worded, which is the failure that would
   * leave a passage reading one way and retrieving another.
   */
  log(
    'an edited passage can be re-approved and is then found by its new wording',
    edits.reApproved === true && edits.foundByNewText === true,
    edits.reApproved
      ? `re-approved; ${edits.foundByNewText ? 'retrieves on the new text' : 'but still retrieves on the old vector'}`
      : 'it could not be put back',
  );
  /*
   * Removing one passage without losing the rest of its page.
   *
   * Forgetting the source was the only route before, which threw away every other
   * passage kept from that page to remove one — so in practice people kept things
   * they had already decided were wrong. The siblings surviving is the whole point
   * of the check; the count is what would silently regress.
   */
  log(
    'one approved passage can be discarded without losing the rest of its source',
    edits.discardedOne === true && edits.siblingSurvived === true,
    edits.discardedOne
      ? `removed from the corpus${edits.siblingSurvived ? ', its sibling untouched' : ' — but it took a sibling with it'}`
      : 'an approved passage still cannot be discarded on its own',
  );
  log(
    'a discarded passage stays locked — its text is what screening matches against',
    edits.discardedRefused === true,
    edits.discardedRefused ? 'refused' : 'a rejected passage was rewritten',
  );

  /*
   * An image passage must reach the model as an image, not only as the text
   * someone filed it under.
   *
   * The description is the retrieval key — it is what made the passage findable —
   * but the answer often lives in the pixels. A card captioned "definition of X"
   * is enough to find and useless to answer from, and without this the model
   * would confidently work from the caption alone.
   *
   * The image is fetched and inlined by the extension rather than passed as a URL:
   * pictures worth keeping sit behind CDNs with hotlink protection and expiring
   * signed URLs, where Anthropic's fetcher is refused and the extension is not.
   */
  // A real PNG, because the positive path cannot be tested against a URL that
  // 404s — that only exercises the graceful-degradation branch below it.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const imgServer = createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(png);
  });
  await new Promise((r) => imgServer.listen(8896, r));

  const withImage = await panel.evaluate(async () => {
    const send = (req) =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'p', request: req }, res),
      );
    await send({
      kind: 'ingest',
      text: 'Rainfall chart for Reykjavik: the bars show monthly totals, with the wettest month marked in blue and a dashed line for the annual mean.',
      sourceUrl: 'http://localhost:8896/chart.png',
      title: 'Rainfall chart',
      tags: ['image'],
    });
    await new Promise((r) => setTimeout(r, 2500));
    const pend = ((await send({ kind: 'listPending' })).data ?? []).filter((c) =>
      c.source?.tags?.includes('image'),
    );
    if (pend.length) await send({ kind: 'approve', chunkIds: pend.map((c) => c.chunk_id) });
    return (
      await send({
        kind: 'ask',
        question: 'What does the rainfall chart show?',
        settings: { apiKey: 'sk-ant-probe', model: 'claude-opus-5' },
      })
    )?.data;
  });
  const blocks = sent?.body?.messages?.at(-1)?.content ?? [];
  const imageBlocks = Array.isArray(blocks) ? blocks.filter((b) => b.type === 'image') : [];
  log(
    'an image passage is sent as an image, so the model reads it rather than reading about it',
    imageBlocks.length > 0 &&
      imageBlocks.every((b) => b.source?.type === 'base64' && b.source.data?.length > 0),
    imageBlocks.length
      ? `${imageBlocks.length} image(s) inlined as ${imageBlocks.map((b) => b.source.media_type).join(', ')}`
      : 'the model was sent text only — an image answer would come from its caption',
  );
  log(
    'an unreachable image costs you the picture, not the answer',
    typeof withImage?.answer === 'string' && withImage.answer.length > 0,
    withImage?.answer ? 'answer still produced' : 'the whole turn failed',
  );
  imgServer.close();

  /*
   * Remember mode. Two properties make multi-turn safe rather than merely
   * possible, and both fail silently if they break:
   *
   *  - The follow-up is rewritten before retrieval. "What about the second one?"
   *    embeds to nothing useful, so without this a conversation degrades into
   *    searching on pronouns by turn three.
   *  - Prior turns travel as conversation, but the passages ride on *this* turn.
   *    That is what stops the model answering from its own earlier prose, which
   *    would look like a citation and be nothing of the kind.
   */
  const followUp = await panel.evaluate(async () => {
    const send = (req) =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'p', request: req }, res),
      );
    return (
      await send({
        kind: 'ask',
        question: 'and the second one?',
        settings: { apiKey: 'sk-ant-probe', model: 'claude-opus-5' },
        history: [
          { role: 'user', content: 'what do my notes say about tidal power?' },
          { role: 'assistant', content: 'They cover predictability [1].' },
        ],
      })
    )?.data;
  });
  const body = sent?.body ?? {};
  log(
    'a follow-up is rewritten before retrieval, not embedded as a pronoun',
    typeof followUp?.searched_for === 'string' && followUp.searched_for !== 'and the second one?',
    followUp?.searched_for
      ? `"and the second one?" searched as "${followUp.searched_for.slice(0, 60)}"`
      : 'no rewrite happened — retrieval saw the raw follow-up',
  );
  /*
   * The rule that keeps a citation meaningful across turns.
   *
   * Observed in use: with Remember on, the model answered a follow-up from its own
   * earlier reply and stamped [1] on it — but [1] had been renumbered and now
   * pointed at an unrelated passage. The content was right and the attribution was
   * false, which is the worst shape an answer can take here: it looks checkable
   * and is not. Using the conversation is allowed; passing it off as a passage is
   * not, and the prompt has to say both.
   */
  log(
    'the conversation may be used, but never cited as if it were a passage',
    /renumbered every turn/.test(sent?.body?.system ?? '') &&
      /Never attach a citation number to something the current passages do not support/.test(
        sent?.body?.system ?? '',
      ),
    /renumbered every turn/.test(sent?.body?.system ?? '')
      ? 'citation rules present: numbers are per-turn, conversation claims go uncited'
      : 'the prompt does not separate passage citations from conversation recall',
  );

  log(
    'prior turns are context; the passages ride on this turn alone',
    Array.isArray(body.messages) &&
      body.messages.length === 3 &&
      body.messages[0].role === 'user' &&
      !/Passages from their memory/.test(JSON.stringify(body.messages[0].content)) &&
      /Passages from their memory/.test(JSON.stringify(body.messages[2].content)) &&
      // The structural half: whatever the prompt says, the passages must physically
      // ride on the current turn and nowhere else.
      /refer ONLY to the passages in this turn/.test(String(body.system ?? '')),
    Array.isArray(body.messages)
      ? `${body.messages.length} messages, passages only on the last`
      : 'no conversation was sent',
  );

  log(
    'the browser-origin header the API requires is actually sent',
    sent?.headers?.['anthropic-dangerous-direct-browser-access'] === 'true',
    sent
      ? `anthropic-version ${sent.headers['anthropic-version']}, direct-browser-access ${sent.headers['anthropic-dangerous-direct-browser-access'] ?? '(missing — every Ask will fail)'}`
      : 'nothing was sent',
  );

  log(
    'the API key reaches the provider and nowhere else',
    sent?.headers?.['x-api-key'] === 'sk-ant-probe' && !/sk-ant-probe/.test(activityText),
    /sk-ant-probe/.test(activityText)
      ? 'the key appears in the activity log'
      : 'sent as x-api-key, absent from the activity log',
  );
  if (cdp) await cdp.send('Fetch.disable').catch(() => {});

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
