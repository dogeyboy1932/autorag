# lib/ — reference material

Vendored notes so a coding agent reads a verified fact instead of guessing at a spec
that shifted three months ago.

## Read in this order

1. **`webmcp/API-DELTA.md`** — what the WebMCP API *actually* does on this machine,
   verified by running it. Chrome's published docs are wrong in at least one place
   (D3). Read this before writing any registration code.
2. **`tool-design/TOOL-CONTRACT.md`** — all 13 tool schemas, error codes, and
   pagination rules. Written before the implementation on purpose.
3. **`rag/chunking-notes.md`** — chunk size, overlap, and the COOP/COEP decision.
4. **`demo/DEMO-SCRIPT.md`** — the video, which is a deliverable and not a wrap-up.

## Status

| File | State |
|---|---|
| `webmcp/API-DELTA.md` | ✅ written, empirically verified 2026-08-31 |
| `tool-design/TOOL-CONTRACT.md` | ✅ written |
| `rag/chunking-notes.md` | ✅ written |
| `demo/DEMO-SCRIPT.md` | ✅ written — corpus is movies & streaming |

Upstream docs (spec snapshot, imperative/declarative API, secure-tools, OpenAI guide)
are deliberately **not** mirrored here. The API-DELTA supersedes them for our purposes
and a stale mirror is worse than a link:

- Spec — https://webmachinelearning.github.io/webmcp/
- Chrome — https://developer.chrome.com/docs/ai/webmcp
- Imperative API — https://developer.chrome.com/docs/ai/webmcp/imperative-api
- Declarative API — https://developer.chrome.com/docs/ai/webmcp/declarative-api
- `exposedTo` — https://developer.chrome.com/docs/ai/webmcp/secure-tools
- MCP-B docs — https://docs.mcp-b.ai  (also wired up as the `webmcp-docs` MCP server)
