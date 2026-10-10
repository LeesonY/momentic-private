#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import {
  Database,
  AccountsRepository,
  StorageError,
} from '../../packages/storage/dist/index.js';
import { loadDatabaseUrl } from '../images/database-url.mjs';

const connectionString = await loadDatabaseUrl();

const email = process.env.ADMIN_INITIAL_EMAIL || 'admin@localqa.internal';
const displayName =
  process.env.ADMIN_INITIAL_DISPLAY_NAME || 'Initial Administrator';

let password = process.env.ADMIN_INITIAL_PASSWORD;
const passwordFile =
  process.env.ADMIN_INITIAL_PASSWORD_FILE ||
  '/run/secrets/admin_initial_password';

if (!password && existsSync(passwordFile)) {
  password = readFileSync(passwordFile, 'utf8').trim();
}

if (!password || password.length < 12) {
  console.error(
    '[LocalQA Bootstrap] ERROR: ADMIN_INITIAL_PASSWORD or ADMIN_INITIAL_PASSWORD_FILE (>=12 chars) is required.',
  );
  process.exit(1);
}

const db = new Database(connectionString);
const accounts = new AccountsRepository(db);

console.log(
  `[LocalQA Bootstrap] Initializing initial administrator account for: ${email}`,
);

try {
  const admin = await accounts.bootstrap({
    email,
    displayName,
    password,
  });
  console.log(
    `[LocalQA Bootstrap] Successfully bootstrapped admin account. ID: ${admin.id}, Global Role: ${admin.globalRole}`,
  );
  console.log(
    '[LocalQA Bootstrap] Bootstrap closed. Future bootstrap calls are permanently blocked by database state.',
  );
} catch (error) {
  if (error instanceof StorageError && error.code === 'VERSION_CONFLICT') {
    console.warn(
      '[LocalQA Bootstrap] ALREADY_BOOTSTRAPPED: Admin account or users already exist. Bootstrap is closed.',
    );
    process.exit(2);
  }
  console.error('[LocalQA Bootstrap] Failed to bootstrap admin:', error);
  process.exit(1);
} finally {
  await db.close();
}
