#!/usr/bin/env node
/**
 * A tiny static file server for local work and for the smoke test. No dependencies.
 *
 *   node tools/serve.mjs                      http://localhost:8080/
 *   node tools/serve.mjs --port 9000
 *   node tools/serve.mjs --mount /juggling/vr  serve the way the live site does (see below)
 *
 * --mount imitates grahampaasch.com: the page answers at /juggling/vr with NO trailing slash
 * (the site rewrites that to index.html and redirects the slash form to it), and the files live
 * under /juggling/vr/. This is the case that breaks naive relative URLs, so the smoke test runs it.
 *
 * WebXR needs a secure context. http://localhost counts as secure, so for a headset on USB run
 * `adb reverse tcp:8080 tcp:8080` and open http://localhost:8080 in the headset browser.
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/** The only things a deployed copy contains (see README, "Deploying"). */
const PUBLIC = ['index.html', 'src', 'vendor'];

export function createServer(options) {
  const mount = ((options && options.mount) || '').replace(/\/+$/, '');
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);

      if (mount) {
        if (pathname === mount + '/') {
          // What Next.js does with `trailingSlash: false`.
          res.writeHead(308, { Location: mount + url.search });
          res.end();
          return;
        }
        if (pathname === mount) pathname = '/index.html';
        else if (pathname.startsWith(mount + '/')) pathname = pathname.slice(mount.length);
        else return notFound(res);
      } else if (pathname === '/') {
        pathname = '/index.html';
      }

      const relative = path.normalize(pathname).replace(/^[/\\]+/, '');
      const top = relative.split(path.sep)[0];
      const file = path.join(ROOT, relative);
      if (!PUBLIC.includes(top) || !file.startsWith(ROOT + path.sep)) return notFound(res);
      const info = await stat(file).catch(() => null);
      if (!info || !info.isFile()) return notFound(res);

      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('server error');
    }
  });
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

/** Start on a port (0 = any free port). Resolves to { server, port, url }. */
export function listen(options) {
  const o = options || {};
  const server = createServer(o);
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(o.port || 0, o.host || '127.0.0.1', () => {
      const port = server.address().port;
      const mount = (o.mount || '').replace(/\/+$/, '');
      resolve({ server, port, url: 'http://localhost:' + port + (mount || '/') });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const started = await listen({
    port: Number(value('--port') || 8080),
    mount: value('--mount') || '',
    host: value('--host') || '127.0.0.1',
  });
  console.log('Serving ' + ROOT + ' at ' + started.url);
}
