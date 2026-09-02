/**
 * Serves the bridge page over plain http on localhost.
 *
 * Plain http is not laziness: `ws://127.0.0.1` is blocked from an https origin
 * (API-DELTA D16), and a chrome-extension:// origin cannot register WebMCP tools
 * at all (D17). An http localhost page is the only context that can do both, so
 * it is where the desktop bridge has to live.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3210);
const html = readFileSync(resolve(here, 'index.html'));

http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`Autorag bridge page: http://localhost:${port}`);
    console.log('Open it in the browser where the extension is installed, and leave it open.');
  });
