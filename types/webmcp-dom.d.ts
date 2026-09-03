/**
 * `document.modelContext`, as the WebMCP spec defines it.
 *
 * lib.dom has no notion of it, so every reference in this repo went through an
 * `as unknown as { modelContext?: … }` cast. That worked, but it meant the call
 * the spec actually names could not be written literally without giving up type
 * checking on the one call that matters most.
 *
 * `navigator.modelContext` is declared alongside it because older polyfill
 * builds and much of the published documentation put it there (D1), so the
 * fallback path is checked rather than cast too.
 *
 * Optional on both: most pages have neither. Measured `undefined` on
 * wikipedia.org — which is the reason the extension ships the polyfill.
 */
import type { ModelContext } from '@mcp-b/webmcp-types';

declare global {
  interface Document {
    readonly modelContext?: ModelContext;
  }
  interface Navigator {
    readonly modelContext?: ModelContext;
  }
}
