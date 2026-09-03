/**
 * Extension bundler.
 *
 * esbuild rather than the Next pipeline: an MV3 extension is five independent
 * entry points with different privileges, not a website, and Next has no way to
 * emit that shape. The `@` alias points back at the repo root so the extension
 * imports the *same* src/rag modules the web app uses — one engine, two ways in.
 */

import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  reader: resolve(here, 'src/reader/main.ts'),
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

/*
 * Vendor PDF.js.
 *
 * Same MV3 rule as the two above — nothing may be fetched from a CDN — but with
 * more moving parts than either, because PDF.js resolves four kinds of asset at
 * *runtime* from URLs the caller supplies:
 *
 *   pdf.worker.mjs   the parser. Must be a real file: it is loaded as a Worker,
 *                    so it cannot be bundled into the reader with esbuild.
 *   cmaps/           character maps for CJK and other non-Latin encodings.
 *   standard_fonts/  the 14 PDF base fonts, for documents that embed no font.
 *   wasm/            the JBIG2 / OpenJPEG decoders (scanned pages) and qcms
 *                    (colour management).
 *   iccs/            the default CMYK profile.
 *
 * Skipping any of them does not fail loudly. The reader comes up, renders, and
 * quietly produces a blank page or a wall of tofu for the documents that needed
 * the missing piece — which looks like a broken reader rather than a missing
 * file. So all of it ships, and `pnpm ext:check` opens a real PDF.
 *
 * Unlike onnxruntime-web this is a direct dependency with no `exports` map, so
 * plain resolution works and the pnpm-store walk above is not needed.
 */
function copyPdfJs() {
  const require = createRequire(import.meta.url);
  const from = dirname(require.resolve('pdfjs-dist/package.json'));
  const dest = resolve(out, 'pdfjs');
  mkdirSync(dest, { recursive: true });

  // Minified: the reader ships it, and the sourcemap it would otherwise want is
  // a megabyte of no use inside a packed extension.
  cpSync(resolve(from, 'build/pdf.worker.min.mjs'), resolve(dest, 'pdf.worker.mjs'));
  // The stylesheet the TextLayer's DOM is written against. Vendored whole rather
  // than transcribed: the text layer positions every span with CSS custom
  // properties and transforms, and hand-copying that math is how selection ends
  // up subtly misaligned with what is drawn.
  cpSync(resolve(from, 'web/pdf_viewer.css'), resolve(dest, 'pdf_viewer.css'));
  for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    cpSync(resolve(from, dir), resolve(dest, dir), { recursive: true });
  }
  console.log('vendored pdf.js (worker, cmaps, standard_fonts, wasm, iccs) into dist/pdfjs/');
}

function copyStatic() {
  copyOnnxRuntime();
  copyRelay();
  copyPdfJs();
  cpSync(resolve(here, 'manifest.json'), resolve(out, 'manifest.json'));
  cpSync(resolve(here, 'src/sidepanel/index.html'), resolve(out, 'sidepanel.html'));
  cpSync(resolve(here, 'src/sidepanel/sidepanel.css'), resolve(out, 'sidepanel.css'));
  cpSync(resolve(here, 'src/offscreen/index.html'), resolve(out, 'offscreen.html'));
  cpSync(resolve(here, 'src/reader/index.html'), resolve(out, 'reader.html'));
  cpSync(resolve(here, 'src/reader/reader.css'), resolve(out, 'reader.css'));
}

const configs = [
  { ...options, entryPoints: moduleEntries, format: 'esm' },
  { ...options, entryPoints: contentEntries, format: 'iife' },
];

/*
 * Live reload, watch builds only.
 *
 * An extension page cannot hot-reload itself the way a dev server does, and
 * pressing reload after every edit is the wrong loop when you are iterating on
 * layout. So a watch build stamps a build id into `dist/`, and the side panel
 * polls it once a second and reloads when it changes (see `sidepanel/index.html`).
 *
 * Production builds write nothing and the poller is not injected: this must not
 * ship, and it must not be something anyone has to remember to strip.
 */
function stampBuild() {
  writeFileSync(resolve(out, 'build-id.txt'), String(Date.now()));
}

if (watch) {
  for (const config of configs) {
    const ctx = await esbuild.context(config);
    await ctx.watch({});
  }
  copyStatic();
  stampBuild();
  // esbuild's watcher rebuilds the bundles; the stamp is what the panel sees.
  setInterval(stampBuild, 1000);
  console.log(`watching — load unpacked from ${out}`);
  console.log('live reload on: open chrome-extension://<id>/sidepanel.html as a tab');
} else {
  await Promise.all(configs.map((config) => esbuild.build(config)));
  copyStatic();
  console.log(`built — load unpacked from ${out}`);
}
