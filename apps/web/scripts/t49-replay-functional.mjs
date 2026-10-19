/* global localStorage */
// Real React app in Chromium, mock API client: the defect replay has to play a
// real rrweb recording (gzipped evidence → Replayer) with its window, markers,
// timelines and the activity/console/network tabs.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';

const vite = await createViteServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { port: 0, host: '127.0.0.1' },
});
await vite.listen();
const origin = vite.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
  });
  await page.addInitScript(() => {
    localStorage.setItem('LOCALQA_USE_MOCK', 'true');
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(
    `${origin}#/finding-detail?findingId=find_mock_01_calc_error&runId=run_mock_001_completed`,
  );
  const section = page.getByTestId('finding-reproduction');
  await section.waitFor();
  const player = page.getByTestId('finding-recording-player');
  await player.waitFor();

  // The rrweb replay really rendered the recorded page.
  const replayFrame = page.frameLocator(
    '[data-testid="finding-recording-player-stage"] iframe',
  );
  await replayFrame.locator('h1').waitFor();
  assert.equal(await replayFrame.locator('h1').innerText(), '柔性灰度管理平台');

  // Address bar, viewport and clock come from the recording, not from the run.
  assert.equal(
    await page.getByTestId('finding-recording-player-url').innerText(),
    '192.168.111.114:38445/login',
  );
  assert.match(await player.innerText(), /视口 1280 × 720/);
  assert.match(
    await page.getByTestId('finding-recording-player-clock').innerText(),
    /^0:00 \(0:01\)$/,
  );

  // Three marker tracks: 6 steps, 4 problems, 3 reproduction steps.
  assert.equal(
    await page
      .locator('[data-testid^="finding-recording-player-step-"]')
      .count(),
    6,
  );
  assert.equal(await player.locator('.lqa-recording-tick').count(), 4);
  assert.equal(
    await page
      .locator('[data-testid^="finding-recording-player-repro-"]')
      .count(),
    3,
  );
  // The reproduction marker carries the defect's own step text.
  const markerTitle = await page
    .getByTestId('finding-recording-player-repro-2')
    .getAttribute('title');
  // The title quotes the defect's own reproduction step (the mock finding's).
  assert.match(
    markerTitle,
    /第 2 步：2\. 在商品购买数量栏输入 3，选择满 300 减 10 优惠券/,
  );
  // …and the time in it is the player clock, not the wall clock.
  assert.match(markerTitle, / {2}0:0\d$/, 'marker time is m:ss');
  assert.equal(
    /\b\d{2}:\d{2}:\d{2}\b/.test(markerTitle),
    false,
    'no wall clock in the marker tooltip',
  );

  // Playing moves the clock; the player clock is the axis, not wall time.
  await page.getByTestId('finding-recording-player-play').click();
  await page.waitForTimeout(1400);
  await page.getByTestId('finding-recording-player-play').click();
  assert.equal(
    await page.getByTestId('finding-recording-player-clock').innerText(),
    '0:01 (0:01)',
    'playback advanced',
  );
  assert.ok(
    Number.parseFloat(
      await page
        .getByTestId('finding-recording-player-scrub')
        .locator('.lqa-recording-scrub-fill')
        .evaluate((element) => element.style.width),
    ) > 40,
    'the scrub bar followed the playhead',
  );

  // A reproduction marker seeks the player (3rd step sits at 1.24 s).
  await page.getByTestId('finding-recording-player-repro-3').click();
  assert.equal(
    await page.getByTestId('finding-recording-player-clock').innerText(),
    '0:01 (0:01)',
  );

  // Activity rows: actions and the agent's thoughts, page-read within the
  // contract's 100-step limit (a 422 there used to empty this list silently).
  const activity = page.getByTestId('finding-recording-player-activity');
  await activity.waitFor();
  assert.match(await activity.innerText(), /想法/);
  assert.match(await activity.innerText(), /输入账号 smoke_user/);
  assert.equal(
    await page.getByTestId('finding-recording-player-steps-error').count(),
    0,
    'steps loaded',
  );
  assert.equal(
    await page.getByTestId('finding-recording-player-tab-activity').innerText(),
    '活动 12',
    '6 steps with 6 thoughts',
  );
  // A thought row shows the thought itself in the message column (the badge
  // still says 想法), with the full text kept in the cell's title.
  const thoughtCell = activity
    .locator('tbody tr td.is-thought')
    .filter({ hasText: '提示出现了，记录当前页面。' });
  assert.equal(await thoughtCell.count(), 1, 'thought body is the cell text');
  assert.equal(
    (await activity.locator('tbody tr td:last-child').allInnerTexts()).includes(
      '想法',
    ),
    false,
    'the message column never reads just 想法',
  );
  assert.equal(
    await thoughtCell.getAttribute('title'),
    '提示出现了，记录当前页面。',
    'the full thought stays in the tooltip',
  );
  // …and the activity search matches the thought body, not only actions.
  await activity.getByLabel('搜索活动').fill('记录当前页面');
  assert.equal(
    await activity.locator('tbody tr').count(),
    1,
    'only the thought matches',
  );
  assert.match(await activity.innerText(), /提示出现了，记录当前页面。/);
  await activity.getByLabel('搜索活动').fill('');

  // Console tab: levels and text, filtered by level.
  await page.getByTestId('finding-recording-player-tab-console').click();
  const consolePanel = page.getByTestId('finding-recording-player-console');
  await consolePanel.waitFor();
  assert.equal(await consolePanel.locator('tbody tr').count(), 5);
  await consolePanel.getByLabel('控制台级别').selectOption('error');
  assert.equal(await consolePanel.locator('tbody tr').count(), 2);

  // Network tab: name/status/duration, and the failed-only switch.
  await page.getByTestId('finding-recording-player-tab-network').click();
  const networkPanel = page.getByTestId('finding-recording-player-network');
  await networkPanel.waitFor();
  // Nine recorded lines are five requests: starts and finishes are paired.
  assert.equal(await networkPanel.locator('tbody tr').count(), 5);
  assert.match(await networkPanel.innerText(), /pageUsers/);
  assert.equal(
    await page.getByTestId('finding-recording-player-tab-network').innerText(),
    '网络 5',
    'the tab counts requests, not recorded lines',
  );
  await page.getByTestId('finding-recording-player-only-failed').check();
  assert.equal(await networkPanel.locator('tbody tr').count(), 1);
  assert.match(await networkPanel.innerText(), /失败/);

  // 「完整录像」opens the session pane on that task's full recording.
  await page.getByTestId('finding-recording-player-full').click();
  await page.waitForURL(/tab=screen/);
  const screenPlayer = page.getByTestId('screen-recording');
  await screenPlayer.waitFor();
  assert.match(await screenPlayer.innerText(), /完整录像/);

  // A task without a recording keeps the screenshot replay (never a fake player).
  await page.goto(
    `${origin}#/workbench?runId=run_mock_001_completed&tab=screen&taskId=task_mock_exec_01`,
  );
  const evidence = page.getByTestId('browser-evidence-panel');
  await evidence.waitFor();
  assert.equal(
    await page.getByTestId('screen-recording').count(),
    0,
    'no recording, no player',
  );

  // Degraded evidence — a recording cut at the size cap — still replays, with
  // the artifact's own reason instead of "cannot play".
  await page.goto(
    `${origin}#/workbench?runId=run_mock_001_completed&tab=screen&taskId=task_mock_exec_20_2`,
  );
  const degraded = page.getByTestId('screen-recording');
  await degraded.waitFor();
  const warning = await page
    .getByTestId('screen-recording-warning')
    .innerText();
  assert.match(warning, /录像不完整/);
  assert.match(warning, /20 MB 上限/);
  // Unreadable steps are reported, not shown as "no activity".
  await page.getByTestId('screen-recording-tab-activity').click();
  await page.getByTestId('screen-recording-activity').waitFor();
  assert.match(
    await page.getByTestId('screen-recording-steps-error').innerText(),
    /步骤加载失败：Invalid limit/,
  );
  const degradedFrame = page.frameLocator(
    '[data-testid="screen-recording-stage"] iframe',
  );
  await degradedFrame.locator('h1').waitFor();
  assert.equal(
    await degradedFrame.locator('h1').innerText(),
    '柔性灰度管理平台',
  );

  assert.deepEqual(errors, [], 'no page errors while replaying');
  console.log(
    'T49_REPLAY_UI_ACCEPTED replay + markers + tabs + degraded + full recording',
  );
} finally {
  await browser.close();
  await vite.close();
}
