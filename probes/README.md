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

To run one, serve the repo root and open the file, or copy it into `public/`
temporarily.
