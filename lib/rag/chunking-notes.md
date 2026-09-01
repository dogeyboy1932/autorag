# Chunking and embedding notes

## Sizes

| Constant | Value | Why |
|---|---|---|
| `TARGET_CHARS` | 900 | all-MiniLM-L6-v2 truncates at 256 word pieces, roughly 1000–1200 characters of English. Chunks above that lose their tail *silently* at embed time. 900 leaves headroom. |
| `OVERLAP_CHARS` | 150 | A fact split across a boundary stays retrievable from at least one side. |
| `MIN_CHARS` | 80 | Below this a chunk is a fragment; it gets folded into its predecessor rather than indexed. |

Sizes are in characters, not tokens, deliberately: a tokenizer round-trip per chunk
would cost more than the precision is worth at this scale.

## Splitting

Recursive, largest natural boundary first: paragraph → line → sentence → clause → word
→ hard cut. A chunk should be something a human can judge at a glance in the review
queue; arbitrary character windows make the curation UI unreadable, which defeats the
point of having a human gate.

## Normalization

Sources are deliberately varied — encyclopedia prose, availability tables, aggregator
score cards, studio press releases — so `normalizeText` has to survive whatever an
agent pastes without the caller cleaning it first:

- `<script>` and `<style>` bodies dropped entirely
- block tags → paragraph breaks, table cells → ` · ` separators, other tags stripped
- HTML entities decoded, including numeric ones
- bullet glyphs removed, line structure kept
- whole-line boilerplate dropped (cookie banners, "Skip to content", copyright lines)

Boilerplate is matched against a **whole trimmed line only**, never mid-sentence, so a
passage that legitimately discusses cookies survives.

## Why not COOP/COEP

Multi-threaded WASM needs `SharedArrayBuffer`, which needs COOP/COEP headers. Those
headers would also block the cross-origin Hugging Face CDN fetch that downloads the
model, because that CDN does not send CORP. WebGPU with a single-threaded WASM fallback
is the better trade.

## Backend selection

Probe `navigator.gpu.requestAdapter()` **before** creating the pipeline. The obvious
try-webgpu-catch-retry-wasm shape does not work: the first attempt leaves
onnxruntime-web with WebGPU pinned as its execution provider, so the "WASM" retry fails
with the same WebGPU adapter error while claiming to be WASM. Verified in headless
Chrome, where WebGPU is unavailable.
