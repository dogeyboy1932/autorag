'use client';

import { useEffect, useState } from 'react';
import { Fold } from '@/components/ui';
import { extensionPresent } from '@/src/webmcp/extension-bridge';

/**
 * The route from this page to a working extension.
 *
 * ## Why a download and three lines of prose rather than a button that installs
 *
 * A web page cannot install an extension on click. Inline installation was removed
 * in Chrome 71 and nothing replaced it outside the Web Store — so the honest shape
 * is a zip plus instructions, and pretending otherwise would mean a button that
 * silently does nothing on the one browser it matters for.
 *
 * ## Why it is here at all
 *
 * The two halves do different things, and only one of them can be a web page.
 * Everything on this site works on text you paste into it. Keeping a highlight from
 * an article you are actually reading needs to run inside that article, which is
 * what an extension is for. Someone who never installs it still gets a whole
 * product; someone who does gets the part that made it worth building.
 *
 * The file is built during the deploy by `pnpm ext:zip` from the same
 * `extension/dist` the checks ran against, so what this link hands over is the
 * build that passed them.
 */
export default function GetExtension() {
  const [copied, setCopied] = useState(false);
  const [installed, setInstalled] = useState<{ version: string } | null>(null);
  // `version` is vestigial: detection is now "did the extension's content script
  // answer", which proves it is there and says nothing about which build it is.
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    void extensionPresent().then((v) => {
      setInstalled(v);
      setChecked(true);
    });
  }, []);

  return (
    <Fold
      title="The browser extension"
      status={installed ? 'connected' : checked ? 'not installed' : 'checking…'}
    >
      <p className="note">
        {installed
          ? 'This page can reach the extension directly, so the two are working on one corpus rather than two. Open the side panel from the toolbar to keep things while you read.'
          : 'Everything on this page works on text you paste in. The extension adds the part a web page cannot do: highlight anything on any site and keep it in one click, read PDFs so their text can be selected at all, and ask questions from the side panel while you are still on the page.'}
      </p>

      {/*
        Hidden once it is installed rather than left as clutter, and while the check
        is still running, so this does not flash instructions at somebody who does
        not need them.
      */}
      {checked && !installed && (
        <>
          <p>
            <a className="btn primary" href="/autorag-extension.zip" style={{ textDecoration: 'none' }}>
              Download the extension
            </a>
          </p>
          <ol className="note" style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6 }}>
            <li>Unzip it somewhere you will not delete by accident.</li>
            <li>
              Open{' '}
              <code
                style={{ cursor: 'pointer' }}
                title="Copy"
                onClick={() => {
                  void navigator.clipboard.writeText('chrome://extensions').then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                chrome://extensions
              </code>
              {copied && <span style={{ color: 'var(--accent)' }}> copied</span>} and turn on{' '}
              <strong>Developer mode</strong>.
              {/*
                Named because the address bar refuses to navigate to a chrome:// URL
                from a link — the browser blocks it, and a link that looks clickable
                and does nothing reads as a broken site.
              */}
              <span style={{ opacity: 0.75 }}> (paste it; the browser blocks links to it)</span>
            </li>
            <li>
              Choose <strong>Load unpacked</strong> and pick the unzipped folder.
            </li>
          </ol>
          <p className="note">
            Chromium browsers only — Chrome, Brave, Edge. It is not in the Web Store, so
            Developer mode is the only way in; that is also why you can read every line of
            what you just downloaded.
          </p>
        </>
      )}
    </Fold>
  );
}
