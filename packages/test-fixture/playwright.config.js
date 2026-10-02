const { defineConfig, devices } = require('@playwright/test');

const PORT = process.env.PORT || 8080;
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  expect: {
    timeout: 5000
  },
  fullyParallel: false,
  workers: 1, // Single worker for predictable fixture and audit checks
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'off',
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
  webServer: {
    command: 'node server.js',
    url: `${BASE_URL}/api/audit`,
    reuseExistingServer: true,
    timeout: 15000,
  },
});
