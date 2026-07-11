import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readEvents } from './event-log.mjs';
import { SIM } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function startViewer({ dir, port = SIM.viewerPort }) {
  const page = readFileSync(join(HERE, 'viewer.html'), 'utf8');

  const server = createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/index')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    if (req.url.startsWith('/events')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      let sent = 0;
      const flush = () => {
        const all = readEvents(dir);
        for (; sent < all.length; sent++)
          res.write(`data: ${JSON.stringify(all[sent])}\n\n`);
      };
      flush();
      const timer = setInterval(flush, 200);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port);
  const actualPort = server.address().port;
  return { url: `http://localhost:${actualPort}`, close: () => server.close() };
}

// Allow `node scripts/sim/viewer.mjs <runId>` to open a standalone viewer.
if (process.argv[1] && process.argv[1].endsWith('viewer.mjs')) {
  const runId = process.argv[2];
  if (!runId) {
    console.error('usage: node scripts/sim/viewer.mjs <runId>');
    process.exit(1);
  }
  const { runDir } = await import('./config.mjs');
  const v = startViewer({ dir: runDir(runId) });
  console.log(`viewer: ${v.url}`);
}
