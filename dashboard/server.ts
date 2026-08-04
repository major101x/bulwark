/**
 * GasGuard dashboard.
 *
 *   npm run dashboard        # then open http://localhost:8080
 *
 * Serves one page and one JSON endpoint. The KeeperHub API key is read here and
 * never sent to the browser, which is why this is a server rather than a static
 * file.
 */

import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { getState } from './data.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT ?? '8080');

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/api/state') {
      const state = await getState();
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(state, null, 2));
      return;
    }

    if (req.url === '/' || req.url === '/index.html') {
      // Read per request so edits show up on refresh without a restart.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(here, 'index.html'), 'utf8'));
      return;
    }

    if (req.url === '/favicon.ico') {
      // Inline shield glyph, so the browser stops logging a 404 on every load.
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
        '<text y="13" font-size="14">🛡</text></svg>';
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end(svg);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
    );
  }
});

server.listen(PORT, () => {
  console.log(`GasGuard dashboard on http://localhost:${PORT}`);
});
