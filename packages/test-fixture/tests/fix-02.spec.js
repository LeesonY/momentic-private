const { test, expect } = require('@playwright/test');

test.describe('FIX-02: Delayed Rendering, Spinner & Long SSE Connection', () => {
  test('waits for delayed DOM state without relying on networkidle', async ({ page }) => {
    // Navigate with 'domcontentloaded' - DO NOT use 'networkidle' because of the persistent SSE stream
    await page.goto('/fix-02-delayed.html', { waitUntil: 'domcontentloaded' });

    // 1. Initial State: loading spinner is visible
    const spinner = page.locator('[data-testid="loading-spinner"]');
    await expect(spinner).toBeVisible();

    // 2. State Wait: wait for delayed-content-ready to become visible
    const readyBadge = page.locator('[data-testid="delayed-content-ready"]');
    await readyBadge.waitFor({ state: 'visible', timeout: 5000 });
    await expect(readyBadge).toContainText('Dynamic Data Loaded Successfully');

    // 3. Spinner is now hidden
    await expect(spinner).toBeHidden();

    // 4. Verify SSE stream is running concurrently in background (network is NOT idle)
    const sseIndicator = page.locator('[data-testid="sse-status-indicator"]');
    await expect(sseIndicator).toBeVisible();
    await expect(sseIndicator).toContainText('SSE Stream Active');
  });
});
