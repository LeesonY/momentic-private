#!/usr/bin/env node
// Run in a disposable root container, with the dedicated dev secrets volume
// mounted at /secrets. Never emit credentials to stdout or overwrite a secret.
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  writeFileSync,
  chmodSync,
  chownSync,
} from 'node:fs';

const root = '/secrets';
const expected = [
  'postgres_password',
  'database_url',
  'kek.json',
  'worker_identity.json',
  'service_identity.json',
  'admin_initial_password',
];
const existing = readdirSync(root);
if (expected.every((file) => existing.includes(file))) {
  console.log('Dev credentials already exist; keeping all existing values.');
  process.exit(0);
}
if (existing.length > 0)
  throw new Error('Incomplete dev secrets volume: refusing partial overwrite.');

const password = randomBytes(24).toString('hex');
const adminPassword = `Dev-${randomBytes(22).toString('base64url')}!`;
const files = {
  postgres_password: [password, 70],
  database_url: [
    `postgresql://localqa:${encodeURIComponent(password)}@postgres:5432/localqa\n`,
    1001,
  ],
  'kek.json': [
    JSON.stringify({
      activeVersion: 1,
      keys: { 1: randomBytes(32).toString('base64') },
    }),
    1001,
  ],
  'worker_identity.json': [randomBytes(32).toString('hex'), 1001],
  'service_identity.json': [
    JSON.stringify({
      services: {
        worker: {
          activeVersion: 1,
          keys: { 1: randomBytes(32).toString('base64') },
        },
        orchestrator: {
          activeVersion: 1,
          keys: { 1: randomBytes(32).toString('base64') },
        },
      },
    }),
    1001,
  ],
  admin_initial_password: [adminPassword, 1001],
};
for (const [file, [content, uid]] of Object.entries(files)) {
  const path = `${root}/${file}`;
  if (existsSync(path))
    throw new Error('Refusing to replace existing credentials');
  writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
  chownSync(path, uid, uid);
  chmodSync(path, 0o600);
}
console.log('Initialized isolated development credentials in Docker volume.');
