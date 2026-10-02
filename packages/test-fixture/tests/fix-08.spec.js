const { test, expect } = require('@playwright/test');

test.describe('FIX-08: HTML5 Canvas & Visual Capability Requirement', () => {
  test('canvas text is absent from DOM tree and page declares data-requires-vision="true"', async ({ page }) => {
    await page.goto('/fix-08-canvas.html');

    // 1. Verify canvas element is visible
    const canvas = page.locator('#qa-test-canvas');
    await expect(canvas).toBeVisible();

    // 2. Verify metadata indicator has data-requires-vision="true"
    const indicator = page.locator('[data-testid="canvas-capability-indicator"]');
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveAttribute('data-requires-vision', 'true');

    // 3. Verify graphical text drawn onto canvas is NOT present in the DOM tree
    // Drawn on canvas: "Quarterly Telemetry Visual Report", "CANVAS_VERIFIED_7749", "Phase 1"
    const canvasTexts = [
      'Quarterly Telemetry Visual Report',
      'CANVAS_VERIFIED_7749',
      'Phase 1',
      '140 ms',
    ];

    const bodyText = await page.evaluate(() => document.body.innerText);

    for (const text of canvasTexts) {
      expect(bodyText).not.toContain(text);
      expect(await page.locator(`text=${text}`).count()).toBe(0);
    }
  });
});
