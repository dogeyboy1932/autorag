/**
 * The only place the corpus exists.
 *
 * A service worker cannot host this: it has no DOM, WebGPU is unavailable to it,
 * and Chrome kills it after ~30s idle, which would evict a 25MB model on every
 * lull. An offscreen document is a real document that survives, so the embedding
 * pipeline warms once and stays warm while the browser is open.
 *
 * Everything here is the existing RAG core, unchanged. The extension is a new
 * way in, not a new engine.
 */

import { ingestPassage, dryRun } from '@/src/rag/ingest';
import { search, confidenceOf, coverageNote } from '@/src/rag/search';
import { allChunks, allSources, countByStatus, decideChunks } from '@/src/rag/store';
import { warmup, warmupState, EMBEDDING_MODEL, EMBEDDING_DIM, isReady } from '@/src/rag/embed';
import { env } from '@huggingface/transformers';
import { isEnvelope, type Request, type Response } from '../protocol';

/*
 * Point the ONNX runtime at the copy vendored next to this bundle.
 *
 * By default transformers.js dynamically imports its WASM backend from jsdelivr.
 * Extension pages run under `script-src 'self'`, which blocks that — and the
 * symptom lies to you: the 25MB of model weights download to 100%, then warmup
 * fails with `no available backend found`. Nothing here may depend on a CDN.
 *
 * Must be set before `warmup()`, which shares this module instance.
 */
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/');

// Start the model as soon as the document exists, rather than on first use, so
// the first capture does not eat the download.
void warmup();

async function handle(request: Request): Promise<unknown> {
  switch (request.kind) {
    case 'warmup': {
      const s = warmupState();
      return { ...s, model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIM, ready: isReady() };
    }

    case 'ingest': {
      const result = await ingestPassage({
        text: request.text,
        sourceUrl: request.sourceUrl,
        title: request.title,
        tags: request.tags,
      });
      return {
        source_id: result.sourceId,
        staged_chunk_ids: result.stagedChunkIds,
        chunk_count: result.chunkCount,
        conflicts: result.conflicts,
      };
    }

    case 'dryRun':
      return dryRun({ text: request.text, sourceUrl: request.sourceUrl });

    case 'search': {
      const r = await search(request.query, {
        k: request.topK,
        includeStale: request.includeStale,
      });
      return {
        hits: r.hits,
        confidence: confidenceOf(r.hits, request.query, r.docs),
        unmatched_terms: r.unmatchedTerms,
      };
    }

    case 'answer': {
      const r = await search(request.question, { k: 5 });
      const confidence = confidenceOf(r.hits, request.question, r.docs);
      return {
        question: request.question,
        hits: r.hits,
        confidence,
        // Signals, never a verdict — the caller decides whether this answers the
        // question. Same rule the page app follows (README, "Signals, not verdicts").
        coverage_note: coverageNote(
          r.hits,
          r.totalCandidates,
          confidence,
          r.unmatchedTerms,
          request.question,
        ),
      };
    }

    case 'stats': {
      const [counts, sources, chunks] = await Promise.all([
        countByStatus(),
        allSources(),
        allChunks(),
      ]);
      const w = warmupState();
      return {
        ...counts,
        chunk_count: chunks.length,
        source_count: sources.length,
        model_ready: isReady(),
        // Carried out to the caller because an offscreen document has no console
        // anyone can reach: puppeteer cannot attach to it, and a silent warmup
        // failure is indistinguishable from a slow download.
        model_phase: w.phase,
        model_progress: w.progress,
        model_error: w.error ?? null,
      };
    }

    case 'listPending': {
      const chunks = await allChunks();
      const sources = await allSources();
      const byId = new Map(sources.map((s) => [s.id, s]));
      return chunks
        .filter((c) => c.status === 'pending')
        .map((c) => ({
          chunk_id: c.id,
          text: c.text,
          conflicts: c.conflicts,
          source: {
            url: byId.get(c.sourceId)?.url ?? '',
            title: byId.get(c.sourceId)?.title ?? '',
          },
        }));
    }

    case 'listSources': {
      const [sources, chunks] = await Promise.all([allSources(), allChunks()]);
      return sources.map((s) => ({
        source_id: s.id,
        url: s.url,
        title: s.title,
        stale: s.stale,
        ingested_at: s.ingestedAt,
        approved_chunks: chunks.filter((c) => c.sourceId === s.id && c.status === 'approved').length,
      }));
    }

    case 'approve':
      return { approved: await decideChunks(request.chunkIds, 'approved') };

    case 'reject':
      return { rejected: await decideChunks(request.chunkIds, 'rejected', request.reason) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isEnvelope(message) || message.to !== 'offscreen') return;
  handle(message.request).then(
    (data) => sendResponse({ ok: true, data } satisfies Response),
    (err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  return true; // keep the channel open for the async reply
});
