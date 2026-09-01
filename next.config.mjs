/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
  // Next 16 runs Turbopack by default. An empty config is an explicit opt-in;
  // transformers.js resolution overrides go here in Phase 1 if they prove necessary.
  turbopack: {},
  // Off because the video is a deliverable and the floating badge sits on top of
  // the page for the whole take. `next dev` still reports compile and runtime
  // errors in the terminal and the console; only the on-screen chip is hidden.
  devIndicators: false,
  // NOTE: COOP/COEP are deliberately NOT set. They would enable SharedArrayBuffer
  // (multi-threaded WASM) but would also block the cross-origin Hugging Face CDN
  // fetch that downloads the embedding model, since that CDN does not send CORP.
  // We prefer WebGPU with a single-threaded WASM fallback.
};
export default nextConfig;
