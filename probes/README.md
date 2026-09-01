# Probes

Standalone HTML pages used to establish the facts in `lib/webmcp/API-DELTA.md`. They
have no dependency on the app and are deliberately **outside** `public/`, so they are
not part of the deployed build.

- `native-check.html` — which global carries `modelContext`, and which Chrome launch
  flag actually enables it. (`--enable-features=WebMCP` works;
  `--enable-webmcp-testing` does not.)
- `native-tool.html` — registers a tool on native Chrome with no polyfill and reports
  the real call shape: `execute` arity, whether a second argument exists, whether
  `inputSchema` comes back as a string or an object, and whether `AbortController`
  actually unregisters.

- `webmcp-loop.mjs` — the whole product as fifteen assertions, driven entirely through
  `document.modelContext.executeTool`. Empty-memory tool registration, ingest, conflict
  flagging, agent adjudication, human rejection, approval (which retracts its own tool
  group), retrieval with provenance, rejection replay, the declarative `<form>` path,
  structured errors, `inputSchema` shape, and a check for uncaught rejections.

```bash
pnpm dev                                    # in another terminal
pnpm loop                                   # Brave, the default
pnpm loop --executable /usr/bin/google-chrome
pnpm loop --url https://your-deploy.example
```

It launches with a throwaway profile — your real profile is never touched — and exits
non-zero if any check fails. Run it on more than one browser: D15 was a timing-dependent
failure that Chrome 151 passed and Brave/Chromium 152 caught.

To run one of the HTML probes, serve the repo root and open the file, or copy it into
`public/` temporarily.
