/**
 * Extension bundler.
 *
 * esbuild rather than the Next pipeline: an MV3 extension is five independent
 * entry points with different privileges, not a website, and Next has no way to
 * emit that shape. The `@` alias points back at the repo root so the extension
 * imports the *same* src/rag modules the web app uses — one engine, two ways in.
 */

import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(here, 'dist');
const watch = process.argv.includes('--watch');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const options = {
  bundle: true,
  target: 'chrome116',
  platform: 'browser',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
  jsx: 'automatic',
  alias: { '@': root },
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  outdir: out,
};

/*
 * Two builds, because content scripts are not modules.
 *
 * The service worker, the side panel and the offscreen document are all loaded
 * as `type="module"`, so they ship as ESM. Content scripts declared in the
 * manifest are classic scripts — a top-level `import` or `export` in one is a
 * syntax error at injection time, and the failure is silent. IIFE for those.
 */
const moduleEntries = {
  background: resolve(here, 'src/background.ts'),
  offscreen: resolve(here, 'src/offscreen/main.ts'),
  sidepanel: resolve(here, 'src/sidepanel/main.tsx'),
};

const contentEntries = {
  'content-selection': resolve(here, 'src/content/selection.ts'),
  'content-webmcp': resolve(here, 'src/content/webmcp.ts'),
};

/*
 * Vendor the ONNX runtime.
 *
 * transformers.js resolves its WASM backend by *dynamically importing it from
 * jsdelivr at runtime*. An MV3 extension page runs under `script-src 'self'`, so
 * that import is blocked — and the failure is silent and misleading: the model
 * weights download to 100%, then the backend reports "no available backend
 * found". Copying the runtime next to the bundle and pointing `wasmPaths` at it
 * is the fix; nothing about the extension may depend on a CDN it cannot reach.
 */
function copyOnnxRuntime() {
  const require = createRequire(import.meta.url);
  /*
   * Resolved by walking, not by `require.resolve`. onnxruntime-web is a
   * transitive dependency that pnpm does not hoist, and both packages block the
   * subpath with an `exports` map, so neither `onnxruntime-web/package.json` nor
   * `@huggingface/transformers/package.json` is resolvable. The store layout is
   * the only thing that answers.
   */
  const store = resolve(root, 'node_modules/.pnpm');
  const pkg = readdirSync(store).find((d) => d.startsWith('onnxruntime-web@'));
  if (!pkg) throw new Error('onnxruntime-web not found in the pnpm store');
  const dist = resolve(store, pkg, 'node_modules/onnxruntime-web/dist');
  const dest = resolve(out, 'ort');
  mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const file of readdirSync(dist)) {
    if (!file.startsWith('ort-wasm')) continue;
    cpSync(resolve(dist, file), resolve(dest, file));
    n++;
  }
  if (n === 0) throw new Error('no ort-wasm* files found; the extension would fail at runtime');
  console.log(`vendored ${n} onnxruntime files into dist/ort/`);
}

/*
 * Vendor the relay embed.
 *
 * Same reason as the ONNX runtime: MV3 forbids loading scripts from a CDN, and
 * the relay's own docs assume a `<script src="https://cdn.jsdelivr.net/...">`.
 * We ship embed.js, widget.html and widget.js inside the extension and serve
 * them from web_accessible_resources instead. The embed fetches widget.html as a
 * sibling of its own URL, so all three must land in the same directory.
 */
function copyRelay() {
  const store = resolve(root, 'node_modules/.pnpm');
  const pkg = readdirSync(store).find((d) => d.startsWith('@mcp-b+webmcp-local-relay@'));
  if (!pkg) throw new Error('@mcp-b/webmcp-local-relay not found in the pnpm store');
  const from = resolve(store, pkg, 'node_modules/@mcp-b/webmcp-local-relay/dist/browser');
  const dest = resolve(out, 'relay');
  mkdirSync(dest, { recursive: true });
  for (const file of ['embed.js', 'widget.html', 'widget.js']) {
    cpSync(resolve(from, file), resolve(dest, file));
  }
  console.log('vendored the relay embed into dist/relay/');
}

function copyStatic() {
  copyOnnxRuntime();
  copyRelay();
  cpSync(resolve(here, 'manifest.json'), resolve(out, 'manifest.json'));
  cpSync(resolve(here, 'src/sidepanel/index.html'), resolve(out, 'sidepanel.html'));
  cpSync(resolve(here, 'src/sidepanel/sidepanel.css'), resolve(out, 'sidepanel.css'));
  cpSync(resolve(here, 'src/offscreen/index.html'), resolve(out, 'offscreen.html'));
}

const configs = [
  { ...options, entryPoints: moduleEntries, format: 'esm' },
  { ...options, entryPoints: contentEntries, format: 'iife' },
];

if (watch) {
  for (const config of configs) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
  }
  copyStatic();
  console.log(`watching — load unpacked from ${out}`);
} else {
  await Promise.all(configs.map((config) => esbuild.build(config)));
  copyStatic();
  console.log(`built — load unpacked from ${out}`);
}
