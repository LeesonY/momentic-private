const { test, expect } = require('@playwright/test');

test.describe('FIX-05: DOM Ambiguity, Duplicate Text & Hidden Elements', () => {
  test('disambiguates between 9 identical "Inspect" buttons using data-testid', async ({ page }) => {
    await page.goto('/fix-05-dom-ambiguity.html');

    // Verify there are exactly 9 buttons with identical text "Inspect"
    const duplicateButtons = page.getByRole('button', { name: 'Inspect' });
    await expect(duplicateButtons).toHaveCount(9);

    // Clicking by text alone would violate strict mode (9 candidates).
    // Use data-testid for precise target identification.
    const btnBeta = page.locator('[data-testid="btn-inspect-beta"]');
    await btnBeta.click();
    await expect(page.locator('[data-testid="inspected-result"]')).toHaveText('LQA_BETA_002');

    // Click another target (Zeta)
    const btnZeta = page.locator('[data-testid="btn-inspect-zeta"]');
    await btnZeta.click();
    await expect(page.locator('[data-testid="inspected-result"]')).toHaveText('LQA_ZETA_006');
  });

  test('hidden buttons (display:none and visibility:hidden) are non-interactive', async ({ page }) => {
    await page.goto('/fix-05-dom-ambiguity.html');

    const displayNoneBtn = page.locator('[data-testid="hidden-ghost-btn"]');
    const visibilityHiddenBtn = page.locator('[data-testid="invisible-ghost-btn"]');

    // Assert both are hidden
    await expect(displayNoneBtn).toBeHidden();
    await expect(visibilityHiddenBtn).toBeHidden();

    // Attempting to click must reject / timeout
    await expect(displayNoneBtn.click({ timeout: 500 })).rejects.toThrow();
    await expect(visibilityHiddenBtn.click({ timeout: 500 })).rejects.toThrow();
  });
});
