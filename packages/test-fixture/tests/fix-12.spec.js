const { test, expect } = require('@playwright/test');

test.describe('FIX-12: Sentinels for Redaction Testing', () => {
  test('sentinels are observable in URL query, input fields, console logs, and network responses', async ({ page }) => {
    const consoleLogs = [];
    page.on('console', msg => consoleLogs.push(msg.text()));

    // 1. URL Query Sentinel
    const querySentinel = 'SENTINEL_TOKEN_SECRET_XYZ8899';
    await page.goto(`/fix-12-sentinels.html?auth_token=${querySentinel}`);
    expect(page.url()).toContain(`auth_token=${querySentinel}`);

    // 2. Sensitive Form Field Sentinel
    const passInput = page.locator('[data-testid="sensitive-input-pass"]');
    await expect(passInput).toBeVisible();
    await expect(passInput).toHaveValue('SENTINEL_PASSWORD_SUPER_SECRET_9999');

    // 3. Browser Console Stream Sentinel
    const emitConsoleBtn = page.locator('[data-testid="btn-emit-console"]');
    await emitConsoleBtn.click();
    const joinedLogs = consoleLogs.join(' ');
    expect(joinedLogs).toContain('SENTINEL_TOKEN_SECRET_XYZ8899');
    expect(joinedLogs).toContain('SENTINEL_API_KEY_LIVE_QA_TEST_7777');

    // 4. Network Response Payload Sentinel
    const [networkResponse] = await Promise.all([
      page.waitForResponse(res => res.url().includes('/api/fix-12/network-sentinel')),
      page.locator('[data-testid="btn-fetch-network"]').click(),
    ]);

    expect(networkResponse.status()).toBe(200);
    const networkJson = await networkResponse.json();
    expect(networkJson.sentinelDetected).toBe(querySentinel);
    expect(networkJson.apiKey).toBe('SENTINEL_API_KEY_LIVE_QA_TEST_7777');

    // Also verify DOM reflected network result
    await expect(page.locator('#network-result')).toContainText('SENTINEL_TOKEN_SECRET_XYZ8899');
  });
});
