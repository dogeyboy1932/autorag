/**
 * Which extension contexts can register a WebMCP tool?
 *
 *   pnpm ext && node probes/extension-origin-check.mjs
 *
 * D17 recorded `registerTool` rejecting with `SecurityError` on a
 * `chrome-extension://` origin — but it was only ever measured in the offscreen
 * document, and the finding was generalised to "extension pages" without testing
 * the others. That generalisation decides the whole desktop-bridge architecture,
 * so it is worth ten minutes to find out whether it is true.
 *
 * Three contexts, one trivial tool each:
 *   - offscreen document   (where D17 was measured)
 *   - side panel page      (opened as an ordinary tab here; same origin and CSP)
 *   - a bare extension page with nothing else running on it
 *
 * A bare page separates *origin* from *everything else the document is doing* —
 * if the side panel rejects but a bare page accepts, the cause is not the origin
 * at all and D17 is misfiled.
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

/** Runs in whatever document we point it at. Reports precisely why it failed. */
const attempt = async () => {
  const out = {
    modelContext: typeof document.modelContext,
    href: location.href.slice(0, 60),
    isSecureContext: window.isSecureContext,
  };
  const ctx = document.modelContext;
  if (!ctx?.registerTool) return { ...out, registered: false, why: 'no registerTool' };
  try {
    await ctx.registerTool({
      name: 'autorag_origin_probe',
      description: 'A trivial tool used only to find out whether registration is permitted here.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    const names = (await ctx.getTools()).map((t) => t.name);
    return { ...out, registered: names.includes('autorag_origin_probe'), tools: names };
  } catch (err) {
    const e = err;
    return {
      ...out,
      registered: false,
      why: `${e?.name ?? typeof err} / ${e?.message ?? ''} / ${JSON.stringify(err)}`,
    };
  }
};

const browser = await puppeteer.launch({
  executablePath: arg('executable', '/snap/bin/brave'),
  headless: false,
  userDataDir: mkdtempSync(join(tmpdir(), 'autorag-origin-')),
  args: [
    '--no-first-run',
    '--no-default-browser-check',
    ...(process.argv.includes('--native') ? ['--enable-features=WebMCP'] : []),
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
  ],
});

const report = (label, r) =>
  console.log(
    `${r?.registered ? 'CAN  ' : 'CANNOT'}  ${label.padEnd(26)} ${
      r?.registered ? `(${r.tools.length} tools on this document)` : (r?.why ?? 'no result')
    }`,
  );

try {
  // A web page first, as the control: this one is known to work.
  const page = await browser.newPage();
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.modelContext, { timeout: 20_000 }).catch(() => {});
  report('https web page (control)', await page.evaluate(attempt));

  const swTarget = browser.targets().find((t) => t.url().includes('/background.js'));
  const extId = swTarget ? new URL(swTarget.url()).host : null;
  console.log(`\nextension id: ${extId}\n`);

  // The side panel, opened as an ordinary tab: same origin, same CSP.
  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1500));
  report('extension page (sidepanel)', await panel.evaluate(attempt));

  // A bare extension page: same origin, nothing else running on it. This is what
  // separates "the origin is forbidden" from "something on that page broke it".
  const bare = await browser.newPage();
  await bare.goto(`chrome-extension://${extId}/offscreen.html`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1500));
  report('extension page (bare tab)', await bare.evaluate(attempt));

  // And the offscreen document itself, read through the activity log it keeps,
  // since puppeteer cannot attach to an offscreen target.
  const activity = await panel
    .evaluate(async () => {
      const send = (req) =>
        new Promise((res) =>
          chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'o', request: req }, res),
        );
      return (await send({ kind: 'activity' })).data;
    })
    .catch(() => []);
  const line = (activity ?? []).find((e) => /publish/i.test(e.message));
  console.log(
    `${line?.phase === 'done' ? 'CAN  ' : 'CANNOT'}  ${'offscreen document'.padEnd(26)} ${
      line?.message ?? 'no bridge attempt recorded'
    }`,
  );

  console.log(
    '\nIf any extension context says CAN, the desktop bridge can live inside the\n' +
      'extension with no server. If all say CANNOT, use the connector page.',
  );
} catch (err) {
  console.error('run failed:', err);
} finally {
  await browser.close();
}
