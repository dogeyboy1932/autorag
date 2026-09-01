/**
 * Cross-browser conformance run for Autorag's WebMCP surface.
 *
 *   node probes/webmcp-loop.mjs [--executable <path>] [--url <origin>]
 *
 * Defaults to Brave; pass --executable for Chrome or any other Chromium build.
 * Everything runs through `document.modelContext.executeTool` — the tool surface,
 * never the UI — so it exercises the path an agent uses rather than the one that
 * is convenient to test. That distinction is the subject of API-DELTA D12 and D14.
 *
 * Always launches with a throwaway profile. Your real browser profile is never
 * touched, and the corpus each run builds is discarded with it.
 *
 * Requires the app to be running (`pnpm dev`).
 */
import puppeteer from 'puppeteer-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BRAVE = arg('executable', '/snap/bin/brave');
const APP = arg('url', 'http://localhost:3111');
const steps = [];
const log = (name, detail) => {
  steps.push({ name, ...detail });
  console.log(`${detail.ok ? 'PASS' : 'FAIL'}  ${name}${detail.note ? ` — ${detail.note}` : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: BRAVE,
  headless: false,
  userDataDir: mkdtempSync(join(tmpdir(), 'brave-loop-')),
  args: ['--no-first-run', '--no-default-browser-check', '--enable-features=WebMCP'],
});

/*
 * Is WebMCP native here, or is @mcp-b/global standing in?
 *
 * Sampled at document-start on the real origin, before a line of app code runs.
 * `about:blank` is the wrong place to ask — it is not a normal secure origin and
 * reports `undefined` even on a browser that does supply the surface.
 */
const probe = await browser.newPage();
await probe.evaluateOnNewDocument(() => {
  window.__nativeAtStart = typeof document.modelContext;
});
await probe.goto(APP, { waitUntil: 'domcontentloaded' });
const nativeSurface = await probe.evaluate(() => window.__nativeAtStart);
await probe.close();

console.log(`browser   ${await browser.version()}`);
console.log(
  `webmcp    ${nativeSurface === 'object' ? 'native (document.modelContext present before any app code)' : `polyfilled by @mcp-b/global (native is ${nativeSurface})`}`,
);
console.log(`app       ${APP}\n`);

const page = await browser.newPage();

// Helpers injected once, then reused. `executeTool` takes the RegisteredTool
// object and a JSON *string*, and answers with a serialized CallToolResult.
await page.evaluateOnNewDocument(() => {
  window.__mcp = {
    async tools() {
      return (await document.modelContext.getTools()).map((t) => t.name).sort();
    },
    async call(name, args) {
      const all = await document.modelContext.getTools();
      const tool = all.find((t) => t.name === name);
      if (!tool) return { __missing: true, name };
      const raw = await document.modelContext.executeTool(tool, JSON.stringify(args ?? {}));
      const envelope = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const text = envelope?.content?.[0]?.text;
      return {
        __envelope: !!envelope?.content,
        __isError: !!envelope?.isError,
        payload: text ? JSON.parse(text) : null,
      };
    },
  };
});

const call = (name, args) => page.evaluate((n, a) => window.__mcp.call(n, a), name, args);
const tools = () => page.evaluate(() => window.__mcp.tools());

try {
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    async () => document.modelContext && (await document.modelContext.getTools()).length >= 5,
    { timeout: 90_000 },
  );
  // Wait for the embedding model, which downloads on a cold profile.
  await page.waitForFunction(
    async () => {
      const t = await document.modelContext.getTools();
      const tool = t.find((x) => x.name === 'autorag_get_stats');
      if (!tool) return false;
      const raw = await document.modelContext.executeTool(tool, '{}');
      const env = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return JSON.parse(env.content[0].text).model_ready === true;
    },
    { timeout: 300_000, polling: 2000 },
  );

  const empty = await tools();
  log('empty memory offers only the always-on group', {
    ok: empty.length === 5 && !empty.includes('autorag_search'),
    note: `${empty.length} tools, no autorag_search`,
    detail: empty,
  });

  const noSearch = await call('autorag_answer_with_sources', { question: 'anything' });
  log('retrieval tool genuinely absent, not just empty', {
    ok: noSearch.__missing === true,
    note: 'answer_with_sources is not registered',
  });

  const wiki = await call('autorag_ingest_passage', {
    text: 'Dune: Part Two is a 2024 epic science fiction film directed by Denis Villeneuve. The film stars Timothee Chalamet as Paul Atreides and Zendaya as Chani. It has a runtime of 166 minutes and was distributed by Warner Bros. Pictures.',
    source_url: 'https://en.wikipedia.org/wiki/Dune:_Part_Two',
    title: 'Dune: Part Two - Wikipedia',
    tags: ['film', 'reference'],
  });
  log('ingest returns a real MCP envelope', {
    ok: wiki.__envelope && wiki.payload?.ok === true,
    note: `staged ${wiki.payload?.chunk_count} chunk(s)`,
  });

  const afterIngest = await tools();
  log('approval group appears once something is staged', {
    ok: afterIngest.includes('autorag_approve_pending'),
    note: `${afterIngest.length} tools`,
  });

  const rt = await call('autorag_ingest_passage', {
    text: 'Dune: Part Two holds a 92 percent critical aggregate score based on over 500 reviews. The audience score sits at 95 percent. The film is rated PG-13 for sequences of strong violence.',
    source_url: 'https://www.rottentomatoes.com/m/dune_part_two',
    title: 'Dune: Part Two - Rotten Tomatoes',
    tags: ['film', 'reviews'],
  });

  const bad = await call('autorag_ingest_passage', {
    text: 'Dune: Part Two holds a 79 percent critical aggregate score across sampled outlets, making it the weakest entry in the series. Grab it before it leaves at the end of the month.',
    source_url: 'https://movieblog.example/dune-part-two',
    title: 'Dune: Part Two scores (MovieBlog)',
    tags: ['film', 'reviews'],
  });
  log('contradiction flagged against pending material', {
    ok: (bad.payload?.conflicts ?? []).some((c) => c.kind === 'contradiction'),
    note: bad.payload?.conflict_summary,
  });

  const verdict = await call('autorag_adjudicate_conflict', {
    chunk_id: bad.payload.staged_chunk_ids[0],
    against_chunk_id: bad.payload.conflicts[0].against_chunk_id,
    ruling: 'keep_existing',
    reasoning: 'The blog gives 79 percent with no methodology and no date, against a dated Rotten Tomatoes figure of 92 percent over 500 reviews.',
  });
  log('agent adjudicates the flagged pair', {
    ok: verdict.payload?.ok === true,
    note: verdict.payload?.ruling,
  });

  const rejected = await call('autorag_reject_pending', {
    chunk_ids: [bad.payload.staged_chunk_ids[0]],
    reason: 'Undated blog, no methodology, contradicts Rotten Tomatoes.',
  });
  log('human rejects with a reason', { ok: rejected.payload?.ok === true });

  // D11: this empties the queue and so retracts its own tool group.
  const approved = await call('autorag_approve_pending', {
    chunk_ids: [wiki.payload.staged_chunk_ids[0], rt.payload.staged_chunk_ids[0]],
  });
  log('approve returns cleanly while retracting its own group (D11)', {
    ok: approved.payload?.ok === true && approved.payload.approved_chunk_ids.length === 2,
    note: approved.payload?.message,
  });

  const answer = await call('autorag_answer_with_sources', {
    question: 'What did critics score Dune: Part Two, and how long is it?',
  });
  const text = JSON.stringify(answer.payload);
  log('same question now answers, with provenance', {
    ok: text.includes('92 percent') && text.includes('166') && !text.includes('79 percent'),
    note: `confidence ${answer.payload?.confidence}, ${answer.payload?.sources?.length} sources cited, rejected claim absent`,
  });

  const replay = await call('autorag_check_conflicts', {
    text: 'Dune: Part Two holds a 79 percent critical aggregate score across sampled outlets, making it the weakest entry in the series. Grab it before it leaves at the end of the month.',
    source_url: 'https://movieblog.example/dune-part-two',
    title: 'Dune: Part Two scores (MovieBlog)',
  });
  log('re-proposing rejected material returns the human reason', {
    ok: JSON.stringify(replay.payload).includes('Undated blog'),
    note: replay.payload?.recommendation,
  });

  // The freshly fixed path: toolautosubmit + SubmitEvent.respondWith.
  const before = await call('autorag_get_stats', {});
  const form = await call('autorag_submit_passage_form', {
    source_url: 'https://www.oscars.example/dune-part-two',
    title: 'Dune: Part Two - Academy Awards',
    text: 'Dune: Part Two won two Academy Awards, for Best Sound and Best Visual Effects, from five nominations in total at the ceremony.',
  });
  const after = await call('autorag_get_stats', {});
  log('declarative <form> tool returns a result AND stages a passage', {
    ok:
      form.__envelope &&
      form.payload?.ok === true &&
      after.payload.pending === before.payload.pending + 1,
    note: `pending ${before.payload.pending} -> ${after.payload.pending}`,
  });

  const errorPath = await call('autorag_forget_source', {
    source_id: (await call('autorag_list_sources', {})).payload.items[0].source_id,
  });
  log('structured error names its recovery tool', {
    ok:
      errorPath.__isError &&
      errorPath.payload?.error?.suggested_next_tool === 'autorag_mark_stale',
    note: errorPath.payload?.error?.code,
  });

  const schemaType = await page.evaluate(async () => {
    const t = await document.modelContext.getTools();
    return typeof t.find((x) => x.name === 'autorag_search').inputSchema;
  });
  log('inputSchema arrives as a string on Chromium 152 (D5)', {
    ok: schemaType === 'string',
    note: `typeof inputSchema === "${schemaType}"`,
  });

  const finalTools = await tools();
  log('full surface registered', {
    ok: finalTools.length === 15,
    note: `${finalTools.length} tools`,
  });

  const rejections = await page.evaluate(() => window.__rej ?? []);
  log('no uncaught rejections (D13)', { ok: rejections.length === 0, detail: rejections });
} catch (err) {
  log('run completed', { ok: false, note: String(err) });
} finally {
  const passed = steps.filter((s) => s.ok).length;
  console.log(`\n${passed}/${steps.length} checks passed on ${await browser.version()}`);
  await browser.close();
  process.exit(passed === steps.length ? 0 : 1);
}
