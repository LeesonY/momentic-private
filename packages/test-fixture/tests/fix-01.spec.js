const { test, expect } = require('@playwright/test');

test.describe('FIX-01: Navigation, Tabs, Accordion & Pagination', () => {
  test('tab switching updates content without full page reload', async ({ page }) => {
    await page.goto('/');

    // Set a window marker to verify that tab switching doesn't reload the page
    await page.evaluate(() => {
      window.__pageReloadTracker = 'session-intact';
    });

    // Initial state: Overview tab active
    await expect(page.locator('[data-testid="tab-panel-overview"]')).toBeVisible();
    await expect(page.locator('[data-testid="tab-panel-details"]')).toBeHidden();

    // Click "Details" tab
    await page.locator('[data-testid="tab-btn-details"]').click();
    await expect(page.locator('[data-testid="tab-panel-details"]')).toBeVisible();
    await expect(page.locator('[data-testid="tab-panel-overview"]')).toBeHidden();

    // Click "Specifications" tab
    await page.locator('[data-testid="tab-btn-specs"]').click();
    await expect(page.locator('[data-testid="tab-panel-specs"]')).toBeVisible();
    await expect(page.locator('[data-testid="tab-panel-details"]')).toBeHidden();

    // Verify window tracker still exists (proves no full page refresh happened)
    const tracker = await page.evaluate(() => window.__pageReloadTracker);
    expect(tracker).toBe('session-intact');
  });

  test('<details> accordion collapses and expands', async ({ page }) => {
    await page.goto('/');

    const details = page.locator('[data-testid="accordion-section-1"]');
    const summary = page.locator('[data-testid="accordion-summary-1"]');

    // Before click: details is not open
    expect(await details.getAttribute('open')).toBeNull();

    // Click summary to expand
    await summary.click();
    expect(await details.getAttribute('open')).not.toBeNull();
    await expect(details.locator('p')).toBeVisible();

    // Click again to collapse
    await summary.click();
    expect(await details.getAttribute('open')).toBeNull();
  });

  test('pagination fetches data with LQA_ identifier prefix across pages', async ({ page }) => {
    await page.goto('/');

    // Wait for table rows to load
    const rows = page.locator('#items-table-body tr');
    await expect(rows.first()).toBeVisible();

    // Verify Page 1 item IDs start with LQA_
    const rowCountPage1 = await rows.count();
    expect(rowCountPage1).toBeGreaterThan(0);
    for (let i = 0; i < rowCountPage1; i++) {
      const idText = await rows.nth(i).locator('td').first().textContent();
      expect(idText.trim()).toMatch(/^LQA_/);
    }

    // Click Next Page button
    const nextBtn = page.locator('[data-testid="btn-next-page"]');
    await expect(nextBtn).toBeEnabled();
    await nextBtn.click();

    // Verify page indicator changes to Page 2
    await expect(page.locator('[data-testid="page-indicator"]')).toContainText('Page 2');

    // Verify Page 2 items also strictly adhere to LQA_ convention
    const rowCountPage2 = await rows.count();
    expect(rowCountPage2).toBeGreaterThan(0);
    for (let i = 0; i < rowCountPage2; i++) {
      const idText = await rows.nth(i).locator('td').first().textContent();
      expect(idText.trim()).toMatch(/^LQA_/);
    }
  });
});
