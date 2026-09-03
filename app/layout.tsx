import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Autorag — agent-curated retrieval memory',
  description:
    'A browser-native, agent-curated retrieval memory. No server, no API key, no data leaving the device.',
  /*
   * Tells the Autorag extension to stand down here.
   *
   * The extension registers its own `autorag_*` tools on `document.modelContext`
   * of every page, and this page registers its own — same names, different
   * corpus (the page's IndexedDB, not the extension's offscreen one). Whichever
   * lost the race threw `Tool already registered`, and on the page side that
   * surfaced as an unhandled rejection that took out the rest of the group.
   *
   * A meta tag rather than a runtime check because it is in the served HTML,
   * so it is already there whichever script runs first. The extension reads it
   * before registering anything; see extension/src/content/webmcp.ts.
   */
  other: { 'autorag-owns-modelcontext': '1' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
