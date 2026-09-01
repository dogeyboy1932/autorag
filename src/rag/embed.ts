/**
 * Embedding pipeline — transformers.js, all-MiniLM-L6-v2, 384 dimensions.
 *
 * Runs entirely in the browser. The model (~25MB) downloads once from the
 * Hugging Face CDN and is then served from the browser's cache, which is why
 * `amendments.md` A5.1 calls cold start the top real risk: the first load is
 * slow and silence looks like breakage. Everything here is built around
 * reporting that honestly.
 *
 * Vectors are L2-normalized on the way out, so cosine similarity is a plain
 * dot product in `search.ts`.
 */

import type { FeatureExtractionPipeline } from '@huggingface/transformers';

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIM = 384;

export type WarmupPhase = 'idle' | 'loading' | 'ready' | 'failed';

export interface WarmupState {
  phase: WarmupPhase;
  /** 0..1 across all model files, or null before the first progress event. */
  progress: number | null;
  /** 'webgpu' | 'wasm' — resolved only once the pipeline exists. */
  backend: string | null;
  error?: string;
}

let state: WarmupState = { phase: 'idle', progress: null, backend: null };
const watchers = new Set<(s: WarmupState) => void>();

export function onWarmup(fn: (s: WarmupState) => void): () => void {
  watchers.add(fn);
  fn(state);
  return () => watchers.delete(fn);
}

function setState(next: Partial<WarmupState>) {
  state = { ...state, ...next };
  for (const fn of watchers) fn(state);
}

export function warmupState(): WarmupState {
  return state;
}

export function isReady(): boolean {
  return state.phase === 'ready';
}

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Decides the backend BEFORE building the pipeline.
 *
 * The obvious shape — try webgpu, catch, retry with wasm — does not work: the
 * first attempt leaves onnxruntime-web with WebGPU pinned as its execution
 * provider, so the retry fails with the *same* WebGPU adapter error while
 * claiming to be WASM. Asking `navigator.gpu` first costs one await and avoids
 * a wasted model download.
 */
async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (gpu?.requestAdapter && (await gpu.requestAdapter())) return 'webgpu';
  } catch {
    /* fall through to wasm */
  }
  return 'wasm';
}

/**
 * Loads the model once. Safe to call repeatedly — later callers await the same
 * promise. Tries WebGPU first and falls back to WASM, because WebGPU is absent
 * or broken on plenty of machines and a hard failure here kills the whole app.
 */
export function warmup(): Promise<FeatureExtractionPipeline> {
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = (async () => {
    setState({ phase: 'loading', progress: null });

    const { pipeline, env } = await import('@huggingface/transformers');
    // No server component to this app: never look for a local model directory.
    env.allowLocalModels = false;

    const fileProgress = new Map<string, number>();
    const onProgress = (p: { status?: string; file?: string; progress?: number }) => {
      if (p.status === 'progress' && p.file && typeof p.progress === 'number') {
        fileProgress.set(p.file, p.progress / 100);
        const vals = [...fileProgress.values()];
        setState({ progress: vals.reduce((a, b) => a + b, 0) / vals.length });
      }
    };

    const device = await pickDevice();
    try {
      const pipe = await pipeline('feature-extraction', EMBEDDING_MODEL, {
        device,
        dtype: device === 'webgpu' ? 'fp32' : 'q8',
        progress_callback: onProgress,
      });
      setState({ phase: 'ready', progress: 1, backend: device });
      return pipe as FeatureExtractionPipeline;
    } catch (err) {
      const message = `Embedding backend "${device}" failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      console.error('[autorag]', message);
      setState({ phase: 'failed', error: message });
      // Let a later call retry rather than caching the failure forever.
      pipelinePromise = null;
      throw new Error(message);
    }
  })();

  return pipelinePromise;
}

/**
 * Embeds texts in order. Mean-pooled and normalized, so `dot(a,b)` is cosine.
 * Batched to keep peak memory sane on a long document.
 */
export async function embed(texts: string[], batchSize = 16): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const pipe = await warmup();
  const out: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const tensor = await pipe(batch, { pooling: 'mean', normalize: true });
    const flat = tensor.data as Float32Array;
    for (let j = 0; j < batch.length; j++) {
      // `tensor` is [batch, EMBEDDING_DIM]; slice copies so the backing
      // buffer can be released.
      out.push(new Float32Array(flat.subarray(j * EMBEDDING_DIM, (j + 1) * EMBEDDING_DIM)));
    }
  }
  return out;
}

export async function embedOne(text: string): Promise<Float32Array> {
  const [v] = await embed([text]);
  return v;
}
