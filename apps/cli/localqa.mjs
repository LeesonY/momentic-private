#!/usr/bin/env node
import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const COMMANDS = new Set(['smoke', 'run', 'status', 'stop', 'report']);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const done = new Set(['completed', 'cancelled', 'failed']);
const abort = new AbortController();
let interrupted = false;
process.once('SIGINT', () => {
  interrupted = true;
  abort.abort();
});

function options(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command))
    throw Error('Expected smoke, run, status, stop or report');
  const values = {};
  const allowed = new Set([
    'project',
    'url',
    'environment',
    'auth-profile',
    'cases',
    'run',
    'wait',
    'timeout',
    'output',
    'json',
    'gate',
  ]);
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!flag.startsWith('--') || !allowed.has(flag.slice(2)))
      throw Error('Unknown command option');
    const key = flag.slice(2);
    if (key === 'wait' || key === 'json' || key === 'gate') {
      values[key] = true;
      continue;
    }
    if (
      !rest[i + 1] ||
      rest[i + 1].startsWith('--') ||
      values[key] !== undefined
    )
      throw Error('Missing or duplicate command argument');
    values[key] = rest[++i];
  }
  const ident = (key) => {
    if (!UUID.test(values[key] ?? '')) throw Error(`--${key} must be a UUID`);
    return values[key];
  };
  const optionalId = (key) =>
    values[key] === undefined ? undefined : ident(key);
  if (command === 'smoke' || command === 'run') {
    ident('project');
    optionalId('environment');
    optionalId('auth-profile');
    if (command === 'smoke') {
      const url = new URL(values.url ?? '');
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw Error('Invalid --url');
    } else if (
      !values.cases ||
      !values.cases.split(',').every((id) => UUID.test(id)) ||
      new Set(values.cases.split(',')).size !== values.cases.split(',').length
    )
      throw Error(
        '--cases requires unique comma-separated approved version UUIDs',
      );
  } else {
    ident('run');
  }
  if (values.timeout !== undefined) {
    const seconds = Number(values.timeout);
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400)
      throw Error('Invalid --timeout (1-86400 seconds)');
  }
  if (values.output !== undefined && (command !== 'report' || !values.output))
    throw Error('--output is available only for report');
  return { command, values };
}

async function secret() {
  const inline = process.env.LOCALQA_API_TOKEN?.trim();
  const file = process.env.LOCALQA_API_TOKEN_FILE?.trim();
  if (!!inline === !!file)
    throw Error(
      'Configure exactly one of LOCALQA_API_TOKEN or LOCALQA_API_TOKEN_FILE',
    );
  if (inline) return inline;
  if (!isAbsolute(file)) throw Error('LOCALQA_API_TOKEN_FILE must be absolute');
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > 2000 ||
      (process.platform !== 'win32' &&
        ((stat.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' &&
            stat.uid !== process.getuid())))
    )
      throw Error('Unsafe API token file permissions');
    return (await handle.readFile('utf8')).trim();
  } finally {
    await handle.close();
  }
}

/** Never print authorization headers, body, token or remote error diagnostics. */
async function api(base, token, method, path, body, idempotencyKey) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: abort.signal,
  });
  if (!response.ok) throw Error(`API request failed (HTTP ${response.status})`);
  return response.json();
}

/**
 * Exact CI gate: a terminal run is not sufficient for green status.
 * At least one planned case and a report without coverage/evidence gaps are
 * required. "issue_found" is the only business-failure exit code (1).
 */
export function gate(report) {
  const run = report?.run;
  const cases = report?.cases;
  if (
    !run ||
    run.status !== 'completed' ||
    run.terminationReason !== 'normal' ||
    !Array.isArray(cases) ||
    cases.length === 0 ||
    !report.summary ||
    report.summary.planned !== cases.length ||
    (report.coverageGaps?.length ?? 1) !== 0 ||
    (report.warnings?.length ?? 1) !== 0
  )
    return 2;
  const businessFailure = cases.some(
    (entry) => entry.outcome === 'issue_found',
  );
  const incomplete = cases.some(
    (entry) =>
      !['passed', 'issue_found'].includes(entry.outcome) ||
      !entry.verdict ||
      !['passed', 'issue_found'].includes(entry.verdict.status) ||
      entry.verdict.gaps.length > 0 ||
      entry.verdict.criterionResults.some(
        (c) => c.result === 'unknown' || c.result === 'not_evaluated',
      ),
  );
  const badArtifacts = (report.artifacts ?? []).some(
    (item) =>
      item.status !== 'available' ||
      !['applied', 'not_needed'].includes(item.redaction),
  );
  if (incomplete || badArtifacts) return 2;
  return businessFailure ? 1 : 0;
}

async function main() {
  const { command, values } = options(process.argv.slice(2));
  const base = new URL(process.env.LOCALQA_API_BASE_URL || '');
  if (
    !['https:', 'http:'].includes(base.protocol) ||
    (base.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '::1'].includes(base.hostname)) ||
    base.username ||
    base.password
  )
    throw Error('LOCALQA_API_BASE_URL must be HTTPS or local HTTP');
  const token = await secret();
  let response;
  if (command === 'smoke' || command === 'run') {
    const data =
      command === 'smoke'
        ? {
            projectId: values.project,
            targetUrl: values.url,
            ...(values.environment
              ? { environmentId: values.environment }
              : {}),
            ...(values['auth-profile']
              ? { authProfileId: values['auth-profile'] }
              : {}),
          }
        : {
            projectId: values.project,
            caseVersionIds: values.cases.split(','),
            ...(values.environment
              ? { environmentId: values.environment }
              : {}),
            ...(values['auth-profile']
              ? { authProfileId: values['auth-profile'] }
              : {}),
          };
    response = await api(
      base,
      token,
      'POST',
      command === 'smoke' ? '/api/v1/runs' : '/api/v1/regression-runs',
      data,
      randomUUID(),
    );
  } else {
    const path = `/api/v1/runs/${values.run}`;
    response = await api(
      base,
      token,
      command === 'stop' ? 'POST' : 'GET',
      path +
        (command === 'stop'
          ? '/cancel'
          : command === 'report'
            ? '/report'
            : ''),
    );
  }
  if ((command === 'smoke' || command === 'run') && values.wait) {
    const runId = response.id;
    const deadline = Date.now() + (Number(values.timeout) || 600) * 1000;
    do {
      if (interrupted) return 130;
      const run = await api(base, token, 'GET', `/api/v1/runs/${runId}`);
      if (done.has(run.status)) break;
      if (Date.now() > deadline) {
        console.error('Run did not reach a terminal state before timeout');
        return 2;
      }
      await delay(2000, undefined, { signal: abort.signal });
    } while (true);
    response = await api(base, token, 'GET', `/api/v1/runs/${runId}/report`);
    const exit = gate(response);
    console.log(
      JSON.stringify(
        values.json
          ? response
          : {
              runId,
              status: response.run?.status,
              summary: response.summary,
              gateExit: exit,
            },
        null,
        2,
      ),
    );
    return exit;
  }
  if (command === 'status' && values.gate) {
    if (!done.has(response.status)) {
      console.log(
        JSON.stringify({
          runId: response.id,
          status: response.status,
          gateExit: 2,
        }),
      );
      return 2;
    }
    response = await api(
      base,
      token,
      'GET',
      `/api/v1/runs/${values.run}/report`,
    );
  }
  if (command === 'report' || (command === 'status' && values.gate)) {
    const exit = gate(response);
    if (values.output) {
      await writeFile(values.output, JSON.stringify(response, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    }
    console.log(
      JSON.stringify(
        values.json
          ? response
          : {
              runId: response.run?.id,
              status: response.run?.status,
              summary: response.summary,
              gateExit: exit,
            },
        null,
        2,
      ),
    );
    return values.gate ? exit : 0;
  }
  console.log(JSON.stringify(response, null, 2));
  return 0;
}

if (process.argv[1]?.endsWith('localqa.mjs')) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      // No remote exception detail or token is ever printed.
      console.error(
        interrupted ? 'Cancelled' : 'CLI request or configuration failed',
      );
      process.exitCode = interrupted ? 130 : 2;
    },
  );
}
