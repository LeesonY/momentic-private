const { test, expect } = require('@playwright/test');

test.describe('FIX-06: Frames & Multi-page Popups', () => {
  test('reads and interacts with same-origin iframe content', async ({ page }) => {
    await page.goto('/fix-06-frames.html');

    // Access frame through frameLocator
    const frame = page.frameLocator('[data-testid="iframe-same-origin"]');
    const content = frame.locator('[data-testid="same-origin-content"]');
    await expect(content).toBeVisible();
    await expect(content.locator('h3')).toHaveText('Same-Origin Frame Content');

    // Click interactive button inside frame
    const frameBtn = frame.locator('[data-testid="btn-frame-action"]');
    await frameBtn.click();
    await expect(frameBtn).toHaveText('Frame Clicked!');
  });

  test('locates target elements in newly spawned popup page window', async ({ page }) => {
    await page.goto('/fix-06-frames.html');

    // Listen for popup event while clicking open popup button
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.locator('[data-testid="btn-open-popup"]').click(),
    ]);

    await popup.waitForLoadState('domcontentloaded');

    // Verify elements on the newly opened popup window
    await expect(popup.locator('[data-testid="popup-title"]')).toHaveText('Popup Page (New Tab/Target Window)');
    await expect(popup.locator('[data-testid="popup-content"]')).toBeVisible();
    await expect(popup.locator('[data-testid="popup-page-id"]')).toHaveText('page_popup_tab_fixed_target');

    await popup.close();
  });
});
