/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
  // Next 16 runs Turbopack by default. An empty config is an explicit opt-in;
  // transformers.js resolution overrides go here in Phase 1 if they prove necessary.
  turbopack: {},
  // NOTE: COOP/COEP are deliberately NOT set. They would enable SharedArrayBuffer
  // (multi-threaded WASM) but would also block the cross-origin Hugging Face CDN
  // fetch that downloads the embedding model, since that CDN does not send CORP.
  // We prefer WebGPU with a single-threaded WASM fallback.
};
export default nextConfig;
