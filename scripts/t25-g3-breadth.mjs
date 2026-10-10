// T25 heterogeneous real-model checks. Keeps a durable result for *every*
// tested scenario (including failures), without writing raw provider output,
// model prompts, credentials or unredacted application snapshots.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const rows = [
  {
    id: 'single_step_healthy',
    args: ['scripts/t17-real-interactive.mjs', 'deepseek'],
    expected: 'passed',
  },
  {
    id: 'single_step_fault',
    args: ['scripts/t17-real-interactive.mjs', 'deepseek', 'broken'],
    expected: 'confirmed',
  },
  {
    id: 'checkout_fault',
    args: ['scripts/t15-real-finding.mjs'],
    expected: 'confirmed',
    deepseek: true,
  },
  {
    id: 'recovered_transient',
    args: ['scripts/t16-real-nonconfirm.mjs', 'unconfirmed'],
    expected: 'unconfirmed',
    deepseek: true,
  },
  {
    id: 'blocked_http_503',
    args: ['scripts/t16-real-nonconfirm.mjs', 'blocked'],
    expected: 'blocked',
    deepseek: true,
  },
  {
    id: 'interrupted_reproduction',
    args: ['scripts/t16-real-nonconfirm.mjs', 'interrupted'],
    expected: 'blocked',
    deepseek: true,
  },
  {
    id: 'auth_then_explore',
    args: ['scripts/t19-real-auth-deepseek.mjs'],
    expected: 'authenticated',
  },
];
const start = Number(process.argv[2] ?? '0');
const stop = Number(process.argv[3] ?? String(rows.length));
if (
  !Number.isInteger(start) ||
  !Number.isInteger(stop) ||
  start < 0 ||
  stop > rows.length ||
  stop <= start
)
  throw Error('T25_EXPECTED_BREADTH_RANGE');
const file = join(
  root,
  'docs/validation-results/T25-g3-deepseek-breadth.ndjson',
);
mkdirSync(dirname(file), { recursive: true });

async function run(def) {
  const startTime = Date.now();
  const env = {
    ...process.env,
    ...(def.deepseek ? { LOCALQA_T17_PI_DEEPSEEK: '1' } : {}),
  };
  let truncated = false;
  let timeout = false;
  let raw = '';
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, def.args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const collect = (chunk) => {
      if (raw.length + chunk.length > 220000) {
        truncated = true;
      } else raw += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const watchdog = setTimeout(() => {
      timeout = true;
      if (process.platform === 'win32')
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        }).on('error', () => child.kill());
      else child.kill('SIGKILL');
    }, 200000);
    child.once('error', () => {
      clearTimeout(watchdog);
      resolve(false);
    });
    child.once('close', (code) => {
      clearTimeout(watchdog);
      resolve(code === 0);
    });
  });
  const parsed =
    raw.split(/\r?\n/).flatMap((line) => {
      if (!line.startsWith('{"gate":')) return [];
      try {
        const candidate = JSON.parse(line);
        if (!String(candidate.gate).startsWith('T1')) return [];
        return [candidate];
      } catch {
        return [];
      }
    })[0] ?? null;
  const diagnosed =
    raw.split(/\r?\n/).flatMap((line) => {
      if (!line.startsWith('T25_T16_BLOCKED_DIAGNOSTIC ')) return [];
      try {
        return [JSON.parse(line.slice('T25_T16_BLOCKED_DIAGNOSTIC '.length))];
      } catch {
        return [];
      }
    })[0] ?? null;
  const authorized =
    def.expected === 'authenticated'
      ? result &&
        raw.includes(
          'Real PG 18 + Chromium: Worker.once auth + imported protected explore=success',
        )
      : parsed?.reportedModelIds?.includes('deepseek-flash') &&
        parsed?.usageSources?.includes('reported') &&
        parsed?.runStatus === 'completed';
  const observed =
    def.expected === 'passed'
      ? parsed?.caseVerdicts?.length === 1 &&
        parsed.caseVerdicts[0] === 'passed'
      : def.expected === 'confirmed'
        ? (parsed?.findingStatus === 'confirmed' &&
            parsed?.reproductionOutcome === 'reproduced') ||
          (parsed?.findingStatus === 'confirmed' &&
            parsed?.distinctContexts === 2 &&
            parsed?.caseVerdicts?.filter((v) => v === 'issue_found').length ===
              2)
        : def.expected === 'unconfirmed'
          ? parsed?.findingStatus === 'unconfirmed' &&
            parsed?.reproductionOutcome === 'not_reproduced'
          : def.expected === 'blocked'
            ? parsed?.findingStatus === 'blocked'
            : def.expected === 'authenticated'
              ? authorized
              : false;
  const safeDegraded =
    def.id === 'blocked_http_503' &&
    !result &&
    diagnosed?.findingStatuses?.length === 1 &&
    diagnosed.findingStatuses[0] === 'blocked' &&
    diagnosed?.run?.completion === 'partial' &&
    diagnosed?.verdicts?.includes('blocked') &&
    diagnosed?.jobs?.some(
      (j) => j.role === 'reproducer' && j.status === 'interrupted',
    );
  const classification =
    result && authorized && observed
      ? 'expected'
      : safeDegraded
        ? 'safe_degraded_incomplete_reproduction'
        : 'failed_or_inconclusive';
  return {
    timestamp: new Date().toISOString(),
    scenario: def.id,
    expected: def.expected,
    classification,
    durationMs: Date.now() - startTime,
    processPassed: !!result && !timeout && !truncated,
    providerCalls: Number.isInteger(parsed?.providerCalls)
      ? parsed.providerCalls
      : null,
    modelIds: Array.isArray(parsed?.reportedModelIds)
      ? parsed.reportedModelIds.filter((id) => id === 'deepseek-flash')
      : [],
    outcome: ['complete', 'partial', 'blocked'].includes(parsed?.completion)
      ? parsed.completion
      : safeDegraded
        ? 'partial'
        : null,
    findingStatus: ['confirmed', 'unconfirmed', 'blocked'].includes(
      parsed?.findingStatus,
    )
      ? parsed.findingStatus
      : safeDegraded
        ? 'blocked'
        : null,
    browserAttempts: Number.isInteger(parsed?.caseAttempts)
      ? parsed.caseAttempts
      : null,
    oracleVerdicts: Array.isArray(parsed?.caseVerdicts)
      ? parsed.caseVerdicts.filter((v) =>
          ['passed', 'issue_found', 'blocked', 'inconclusive'].includes(v),
        )
      : [],
    freshContextCount: Number.isInteger(parsed?.distinctContexts)
      ? parsed.distinctContexts
      : null,
    distinctEvidence: parsed?.distinctEvidence === true,
    tokenUsage:
      parsed?.usageTotals?.provenance === 'reported'
        ? {
            input: parsed.usageTotals.inputTokens,
            output: parsed.usageTotals.outputTokens,
            source: 'reported',
          }
        : null,
    reason: timeout
      ? 'process_timeout'
      : truncated
        ? 'output_limit'
        : safeDegraded
          ? 'reproducer_interrupted_recovery_synthesized_blocked'
          : classification === 'expected'
            ? null
            : 'expected_evidence_missing_or_execution_failed',
  };
}
let hardFailures = 0;
let degraded = 0;
for (const def of rows.slice(start, stop)) {
  const sample = await run(def);
  appendFileSync(file, JSON.stringify(sample) + '\n', 'utf8');
  if (sample.classification === 'safe_degraded_incomplete_reproduction')
    degraded++;
  if (sample.classification === 'failed_or_inconclusive') hardFailures++;
  console.log(
    'T25_BREADTH',
    JSON.stringify({
      scenario: sample.scenario,
      classification: sample.classification,
      providerCalls: sample.providerCalls,
      durationMs: sample.durationMs,
    }),
  );
}
if (hardFailures) process.exitCode = 1;
else if (degraded) process.exitCode = 2;
