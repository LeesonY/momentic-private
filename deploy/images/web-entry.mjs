#!/usr/bin/env node
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
if (process.argv.includes('--check')) {
  try { process.exit((await fetch('http://127.0.0.1:8080/readyz',{signal:AbortSignal.timeout(3000)})).ok ? 0 : 1); }
  catch { process.exit(1); }
}
const root = '/app/dist';
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json'};
const server = http.createServer(async (req,res) => {
  if (req.url === '/healthz' || req.url === '/readyz') {
    try { await stat(`${root}/index.html`); res.writeHead(200); res.end('ok\n'); }
    catch { res.writeHead(req.url === '/readyz' ? 503:200); res.end(); }
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(`${root}${sep}`)) { res.writeHead(403); res.end(); return; }
    let target = file;
    try { if (!(await stat(target)).isFile()) target = `${root}/index.html`; }
    catch { target = `${root}/index.html`; }
    const bytes = await readFile(target);
    res.writeHead(200, {'content-type':mime[extname(target)] || 'application/octet-stream','cache-control':'no-store'});
    res.end(bytes);
  } catch { res.writeHead(400); res.end(); }
});
server.listen(8080,'0.0.0.0');
for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => server.close());
