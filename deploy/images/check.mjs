#!/usr/bin/env node
import { readiness } from './readiness.mjs';
import { stat } from 'node:fs/promises';
const target = process.argv[2];
const mode = process.argv[3] || 'ready';
let ok = false;
try {
  if (target === 'api' || target === 'web') {
    const port = target === 'api' ? 3000 : 8080;
    const path = mode === 'live' ? 'healthz' : 'readyz';
    ok = (await fetch(`http://127.0.0.1:${port}/${path}`,{signal:AbortSignal.timeout(3000)})).ok;
  } else if (mode === 'live') {
    ok = process.getuid() !== 0;
  } else if (target === 'worker') {
    ok = await readiness({browserMarker:true});
  } else if (target === 'orchestrator') {
    const marker = await stat('/tmp/orchestrator-ready');
    ok = Date.now() - marker.mtimeMs < 60000 && await readiness({vault:true});
  }
} catch { ok = false; }
process.exit(ok ? 0 : 1);
