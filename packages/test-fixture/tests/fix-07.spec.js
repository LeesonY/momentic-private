const { test, expect } = require('@playwright/test');

test.describe('FIX-07: Browser-level Non-Submitting Policy & Audit Verification', () => {
  test('safe browser exploration yields zero unauthorized mutations (audit count = 0)', async ({ page, request }) => {
    // 1. Reset fixture state before exploration
    const resetRes = await request.post('/api/reset');
    expect(resetRes.ok()).toBeTruthy();
    const resetJson = await resetRes.json();
    expect(resetJson.auditCount).toBe(0);

    // 2. Navigate to mutations page
    await page.goto('/fix-07-mutations.html');

    // 3. Inspect policy banner and audit badge
    await expect(page.locator('h2')).toContainText('Non-Submitting Policy & Mutation Audit');
    await expect(page.locator('[data-testid="audit-count-badge"]')).toContainText('Audit Mutation Count: 0');

    // 4. Safe exploration: execute permitted Safe POST query
    const safePostBtn = page.locator('[data-testid="btn-safe-post"]');
    await safePostBtn.click();
    await expect(page.locator('#safe-post-result')).toContainText('Safe POST Success');

    // 5. Inspect that dangerous elements exist in the DOM (read-only verification, DO NOT click)
    await expect(page.locator('[data-testid="link-dangerous-get"]')).toBeVisible();
    await expect(page.locator('[data-testid="input-autosave"]')).toBeVisible();
    await expect(page.locator('[data-testid="btn-delete-record"]')).toBeVisible();
    await expect(page.locator('[data-testid="btn-send-message"]')).toBeVisible();
    await expect(page.locator('[data-testid="link-external-redirect"]')).toBeVisible();

    // 6. Query read-only audit API to prove NO unauthorized mutations occurred
    const auditRes = await request.get('/api/audit');
    expect(auditRes.ok()).toBeTruthy();
    const auditJson = await auditRes.json();

    // CRITICAL ASSERTION: Audit count MUST remain 0
    expect(auditJson.count).toBe(0);
    expect(auditJson.events).toHaveLength(0);

    // Refresh UI audit view and assert count remains 0 in DOM
    await page.locator('[data-testid="btn-refresh-audit"]').click();
    await expect(page.locator('[data-testid="audit-count-badge"]')).toContainText('Audit Mutation Count: 0');
  });
});
