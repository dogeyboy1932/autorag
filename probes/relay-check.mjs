/**
 * Can a desktop MCP client reach the memory in the browser?
 *
 *   pnpm ext && node probes/relay-check.mjs
 *
 * This is the consuming half of the design — the half that was missing. It starts
 * `@mcp-b/webmcp-local-relay` exactly as Claude Desktop, Cursor or any other MCP
 * client would (a stdio subprocess), opens a browser with the extension loaded,
 * and then speaks raw MCP JSON-RPC down the pipe: initialize, list sources, list
 * tools, call one.
 *
 * If this passes, "your agent can query the memory you curated while browsing" is
 * a measured fact rather than an architecture diagram. No API key is involved and
 * nothing leaves the machine: the relay binds to loopback.
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../extension/dist');
const RELAY = resolve(here, '../node_modules/.pnpm/@mcp-b+webmcp-local-relay@5.1.0/node_modules/@mcp-b/webmcp-local-relay/dist/cli.mjs');

const steps = [];
const log = (name, ok, note) => {
  steps.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
};

/* ---------------------------------------------- an MCP client over stdio --- */

const relay = spawn('node', [RELAY], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
relay.stderr.on('data', (d) => (stderr += d.toString()));

let buffer = '';
const waiting = new Map();
relay.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    } catch {
      /* relay logs non-JSON to stdout occasionally; ignore */
    }
  }
});

let nextId = 1;
function rpc(method, params = {}, timeoutMs = 20_000) {
  const id = nextId++;
  relay.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((res) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      res({ error: { message: `timed out after ${timeoutMs}ms` } });
    }, timeoutMs);
    waiting.set(id, (msg) => {
      clearTimeout(timer);
      res(msg);
    });
  });
}

const callTool = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r.result?.content?.[0]?.text;
  try {
    return text ? JSON.parse(text) : r;
  } catch {
    return text ?? r;
  }
};

/* ------------------------------------------------------------------ browser */

let bridge = null;

const browser = await puppeteer.launch({
  executablePath: '/snap/bin/brave',
  headless: false,
  userDataDir: mkdtempSync(join(tmpdir(), 'autorag-relay-')),
  args: [
    '--no-first-run',
    '--no-default-browser-check',
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
  ],
});

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'autorag-relay-check', version: '1' },
  });
  log('the relay speaks MCP over stdio', !!init.result, init.result?.serverInfo?.name ?? init.error?.message);
  relay.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const tools = await rpc('tools/list');
  const relayTools = (tools.result?.tools ?? []).map((t) => t.name);
  log(
    'the client sees the relay management tools',
    relayTools.includes('webmcp_list_sources'),
    relayTools.join(', '),
  );

  /*
   * The bridge page, served over plain http on localhost.
   *
   * It has to be http and it has to be an ordinary web page: D16 says the relay's
   * socket dies from an https origin, D17 says a chrome-extension:// origin cannot
   * register tools at all. This is the only context that satisfies both, and the
   * extension does the rest — its content scripts put the memory tools on this
   * page and inject the relay embed because the origin is http.
   */
  bridge = spawn('node', [resolve(here, '../extension/connector/serve.mjs')], {
    stdio: 'ignore',
    env: { ...process.env, PORT: '3210' },
  });
  await new Promise((r) => setTimeout(r, 600));

  const page = await browser.newPage();
  await page.goto('http://localhost:3210/', { waitUntil: 'domcontentloaded' });
  await page
    .waitForFunction(
      async () =>
        document.modelContext &&
        (await document.modelContext.getTools()).filter((t) => t.name.startsWith('autorag_')).length >= 4,
      { timeout: 30_000 },
    )
    .catch(() => {});

  // Put something in the memory so recall has an answer to give, through the
  // same tools an agent would use.
  await page.evaluate(async () => {
    const ctx = document.modelContext;
    const all = await ctx.getTools();
    const call = async (name, args) => {
      const raw = await ctx.executeTool(all.find((t) => t.name === name), JSON.stringify(args));
      const env = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return JSON.parse(env.content[0].text);
    };
    await call('autorag_remember_passage', {
      text: 'The Autorag bridge page exists because a loopback WebSocket cannot be opened from an https origin, and WebMCP refuses tool registration on a chrome-extension origin.',
      title: 'Why the bridge page exists',
    });
  });

  // Discovery is not instant; the embed has to connect and enumerate.
  let sources = null;
  for (let i = 0; i < 20; i++) {
    sources = await callTool('webmcp_list_sources');
    if ((sources?.count ?? 0) > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  log(
    'the browser tab shows up as a connected source',
    (sources?.count ?? 0) > 0,
    sources?.count ? `${sources.count} source: ${sources.sources?.[0]?.url}` : 'no sources connected',
  );

  const browserTools = await callTool('webmcp_list_tools');
  const names = JSON.stringify(browserTools);
  log(
    "the desktop client can see Autorag's tools in the browser",
    names.includes('autorag_recall') && names.includes('autorag_remember_passage'),
    (browserTools?.tools ?? [])
      .map((t) => t.name)
      .filter((n) => n.includes('autorag'))
      .join(', ') || names.slice(0, 120),
  );

  /*
   * Approve what was staged, as the person would in the side panel.
   *
   * Without this the recall below returns zero hits and still "passes" — the
   * approval gate is working exactly as designed and the assertion is simply too
   * weak to notice. A check that goes green against an empty memory is not
   * evidence of anything.
   */
  const swTarget = browser.targets().find((t) => t.url().includes('/background.js'));
  const extId = swTarget ? new URL(swTarget.url()).host : null;
  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1200));
  const approved = await panel.evaluate(async () => {
    const send = (req) =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ __autorag: true, to: 'worker', id: 'a', request: req }, res),
      );
    const pending = (await send({ kind: 'listPending' })).data ?? [];
    if (!pending.length) return 0;
    await send({ kind: 'approve', chunkIds: pending.map((p) => p.chunk_id) });
    return pending.length;
  });
  log('the staged capture can be approved', approved > 0, `${approved} passage(s) approved`);

  /*
   * The one that matters. Everything above proves the wiring; this proves the
   * product: a desktop MCP client, talking stdio to a relay it started itself,
   * searching a memory that lives in the browser — with no API key and nothing
   * leaving the machine.
   */
  const toolName =
    (browserTools?.tools ?? []).map((t) => t.name).find((n) => n.endsWith('autorag_recall')) ??
    'autorag_recall';
  const recalled = await callTool(toolName, { question: 'Why does the bridge page exist?' });
  const hits = recalled?.hits ?? [];
  log(
    'a desktop MCP client gets real passages back, with provenance',
    hits.length > 0 && !!hits[0]?.source?.url,
    hits.length
      ? `${hits.length} passage(s), confidence ${recalled.confidence}, cites ${hits[0].source.url}`
      : `no hits: ${JSON.stringify(recalled).slice(0, 120)}`,
  );
} catch (err) {
  log('run completed', false, String(err));
} finally {
  const passed = steps.filter((s) => s.ok).length;
  console.log(`\n${passed}/${steps.length} checks passed`);
  if (passed < steps.length && stderr.trim()) {
    console.log('\nrelay stderr:\n' + stderr.trim().split('\n').slice(-15).join('\n'));
  }
  await browser.close();
  relay.kill();
  try {
    bridge?.kill();
  } catch {
    /* never started */
  }
  process.exit(passed === steps.length ? 0 : 1);
}
