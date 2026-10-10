import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from '../../../packages/browser/node_modules/playwright/index.mjs';
import { T26_FIXTURES, renderT26Fixture } from './t26-business-fixtures.mjs';

test('T26 all eight distinct business calculations: healthy and faulty marker both visible, results diverge', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const flow of T26_FIXTURES) {
      const observed = [];
      for (const broken of [false, true]) {
        const page = await browser.newPage();
        try {
          const errors = [];
          page.on('pageerror', (err) => errors.push(err.message));
          await page.setContent(renderT26Fixture(flow, broken));
          const structures = {
            'invoice-vat': 'fieldset',
            'support-priority': 'nav[aria-label="服务台导航"]',
            'room-upgrade': 'table[aria-label="房型升级办理"]',
            'cart-quantity': 'aside[aria-label="购物车总计"]',
          };
          const feature = structures[flow.id];
          if (feature) {
            assert.equal(
              await page.locator(feature).count(),
              1,
              flow.id + ' unique T32 page structure is present',
            );
          }
          await page.getByTestId(flow.field).fill(flow.value);
          await page.getByRole('button', { name: flow.first }).click();
          await page.getByRole('button', { name: flow.second }).click();
          const result = page.getByTestId('complete-marker');
          assert.equal(await result.count(), 1);
          assert.equal(await result.isVisible(), true);
          observed.push(await result.textContent());
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      }
      assert.equal(observed[0], flow.expected, flow.id);
      assert.equal(observed[1], flow.wrong, flow.id);
      assert.notEqual(observed[0], observed[1], flow.id);
    }
    console.log(
      'T26_DOM_ORACLES',
      JSON.stringify({
        workflows: T26_FIXTURES.length,
        independentVariants: T26_FIXTURES.length * 2,
        missingResultElements: 0,
        matchedBusinessOutputs: T26_FIXTURES.length * 2,
        faultyPagesStillContainMarker: true,
      }),
    );
  } finally {
    await browser.close();
  }
});

test('T33 actual Chromium modal dialog and open details require the second click and preserve exact oracle', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const flow = T26_FIXTURES.find((item) => item.id === 'support-priority');
    assert.ok(flow);
    for (const faulty of [false, true]) {
      const page = await browser.newPage();
      try {
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setContent(renderT26Fixture(flow, faulty, 't33-dialog'));
        assert.equal(await page.locator('details[open]').count(), 1);
        assert.equal(await page.locator('dialog[open]').count(), 0);
        await page.getByTestId(flow.field).fill(flow.value);
        await page.getByRole('button', { name: flow.first }).click();
        assert.equal(await page.locator('dialog[open]').count(), 1);
        assert.equal(await page.getByTestId('complete-marker').count(), 0);
        await page.getByRole('button', { name: flow.second }).click();
        const marker = page.getByTestId('complete-marker');
        assert.equal(await marker.isVisible(), true);
        assert.equal(
          await marker.textContent(),
          faulty ? flow.wrong : flow.expected,
        );
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

test('T34 actual iframe and nested open Shadow DOM asynchronous business buttons preserve frozen exact healthy/fault oracle', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [id, variant] of [
      ['support-priority', 't34-iframe'],
      ['room-upgrade', 't34-shadow'],
    ]) {
      const flow = T26_FIXTURES.find((candidate) => candidate.id === id);
      assert.ok(flow);
      for (const broken of [false, true]) {
        const page = await browser.newPage();
        try {
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.setContent(renderT26Fixture(flow, broken, variant));
          await page.getByTestId(flow.field).fill(flow.value);
          await page.getByRole('button', { name: flow.first }).click();
          assert.equal(await page.getByTestId('complete-marker').count(), 0);
          const second =
            variant === 't34-iframe'
              ? page
                  .frame({ name: 't34-approval' })
                  .getByRole('button', { name: flow.second })
              : page.getByRole('button', { name: flow.second });
          await second.waitFor({ state: 'visible' });
          await second.click();
          assert.equal(
            await page.getByTestId('complete-marker').textContent(),
            broken ? flow.wrong : flow.expected,
          );
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
});

test('T36 real iframe document reload and nested Shadow DOM remount preserve exact healthy/fault business oracles', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [id, variant] of [
      ['support-priority', 't36-frame-reload'],
      ['room-upgrade', 't36-shadow-remount'],
    ]) {
      const flow = T26_FIXTURES.find((candidate) => candidate.id === id);
      assert.ok(flow);
      for (const broken of [false, true]) {
        const page = await browser.newPage();
        try {
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.setContent(renderT26Fixture(flow, broken, variant));
          await page.getByTestId(flow.field).fill(flow.value);
          const frame =
            variant === 't36-frame-reload'
              ? page.frame({ name: 't34-approval' })
              : null;
          if (frame) {
            assert.ok(
              (await frame.locator('body').innerText()).includes('旧审核文档'),
            );
          }
          await page.getByRole('button', { name: flow.first }).click();
          assert.equal(await page.getByTestId('complete-marker').count(), 0);
          const next = frame
            ? frame.getByRole('button', { name: flow.second })
            : page.getByRole('button', { name: flow.second });
          await next.waitFor({ state: 'visible', timeout: 4000 });
          if (frame) {
            assert.equal(
              await frame.locator('body').getAttribute('data-t36-document'),
              'new',
            );
          } else {
            assert.equal(
              await page
                .locator('#shadow-host')
                .evaluate((host) => host.children.length),
              0,
            );
            assert.equal(await page.locator('#shadow-host').count(), 1);
          }
          await next.click();
          assert.equal(
            await page.getByTestId('complete-marker').textContent(),
            broken ? flow.wrong : flow.expected,
          );
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
});
