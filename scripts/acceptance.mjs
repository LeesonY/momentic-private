#!/usr/bin/env node
// Runs a phase acceptance task from scripts/acceptance-tasks.json.
// Task names and commands are unchanged from the former root package.json
// entries, so `pnpm test:t26-matrix` in older reports is now
// `pnpm acceptance test:t26-matrix`. Most tasks need PostgreSQL, Chromium or
// a real model provider; see the matching docs/validation-results report.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tasks = JSON.parse(
  readFileSync(new URL('./acceptance-tasks.json', import.meta.url), 'utf8'),
);
const name = process.argv[2];

if (!name || name === '--list') {
  console.log('Usage: pnpm acceptance <task>\n');
  for (const [task, command] of Object.entries(tasks))
    console.log(`  ${task.padEnd(24)} ${command}`);
  process.exit(name ? 0 : 1);
}
const command = tasks[name];
if (!command) {
  console.error(
    `Unknown acceptance task: ${name} (run \`pnpm acceptance --list\`)`,
  );
  process.exit(1);
}
console.log(`> ${command}`);
const result = spawnSync(command, {
  cwd: root,
  shell: true,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
