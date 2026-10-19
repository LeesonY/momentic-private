/* global Blob */
// Offline verification of the replay UI rules: window→axis math, lane
// classification, problem and reproduction markers, the activity/console/network
// filters, the four recording states, and the gzip evidence reader (on the real
// fixture the mock client serves).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evidencePolicy,
  normalizeRecording,
  readJsonBlob,
} from '../src/api/recording.ts';
import { MOCK_RRWEB_GZIP_BASE64 } from '../src/mocks/recording.ts';
import {
  filterConsole,
  filterNetwork,
  formatClock,
  networkName,
  percentAt,
  problemTicks,
  recordingStatusView,
  reproMarkers,
  shortUrl,
  sortSteps,
  stepBlocks,
  stepLane,
  timelineRange,
  urlAt,
  windowOffset,
} from '../src/utils/recording.ts';

const start = Date.parse('2026-10-19T02:41:53.551Z');
const at = (offsetMs) => new Date(start + offsetMs).toISOString();
const range = timelineRange(
  { startAt: at(0), endAt: at(2000) },
  { startAt: null, endAt: null },
);

const step = (seq, toolName, offsetMs, durationMs = 100) => ({
  id: `step_${seq}`,
  seq,
  toolName,
  createdAt: at(offsetMs),
  finishedAt: at(offsetMs + durationMs),
  summary: `${toolName} ${seq}`,
});

test('a recording window maps onto the axis and clamps at both ends', () => {
  assert.deepEqual(range, {
    startMs: start,
    endMs: start + 2000,
    spanMs: 2000,
  });
  assert.equal(percentAt(at(0), range), 0);
  assert.equal(percentAt(at(1000), range), 50);
  assert.equal(percentAt(at(2000), range), 100);
  // Outside the window clamps instead of drawing off the track.
  assert.equal(percentAt(at(-5000), range), 0);
  assert.equal(percentAt(at(9000), range), 100);
  // A window without usable timestamps has no axis at all.
  assert.equal(timelineRange(null, { startAt: null, endAt: null }), null);
  assert.equal(timelineRange(null, { startAt: 'nope', endAt: at(10) }), null);
  // A zero-length window still draws (span 1ms) instead of dividing by zero.
  const instant = timelineRange(
    { startAt: at(5), endAt: at(5) },
    { startAt: null, endAt: null },
  );
  assert.equal(instant.spanMs, 1);
  assert.equal(windowOffset(range, start + 1500), 1500);
  assert.equal(windowOffset(range, start - 900), 0);
  assert.equal(windowOffset(range, start + 99_999), 2000);
});

test('steps are classified into the four lanes, everything else stays other', () => {
  assert.equal(stepLane('navigate'), 'navigate');
  assert.equal(stepLane('click'), 'click');
  assert.equal(stepLane('type_text'), 'type');
  assert.equal(stepLane('select_option'), 'type');
  assert.equal(stepLane('press'), 'type');
  assert.equal(stepLane('observe'), 'observe');
  assert.equal(stepLane('capture'), 'observe');
  assert.equal(stepLane('wait_for'), 'observe');
  assert.equal(stepLane('browser.navigate'), 'navigate');
  assert.equal(stepLane('inspect_network'), 'other');
  assert.equal(stepLane('assert_criterion'), 'other');
});

test('the steps track keeps only steps inside the window and clamps them', () => {
  const blocks = stepBlocks(
    [
      // Straddles the window start: kept, but drawn from 0%.
      step(1, 'navigate', -100, 300),
      // Entirely before the window: dropped.
      step(9, 'click', -900, 100),
      step(2, 'click', 400, 100),
      step(3, 'type_text', 1900, 400),
      step(4, 'observe', 5000, 100),
    ],
    range,
  );
  assert.deepEqual(
    blocks.map((block) => [block.seq, block.lane]),
    [
      [1, 'navigate'],
      [2, 'click'],
      [3, 'type'],
    ],
  );
  assert.equal(blocks[0].leftPct, 0);
  assert.ok(blocks[0].widthPct <= 15);
  assert.equal(blocks[2].leftPct, 95);
  // A step running past the end is cut at the edge, never drawn beyond 100%.
  assert.ok(blocks[2].leftPct + blocks[2].widthPct <= 100);
});

test('problems are console errors, page errors and failed or 4xx/5xx requests', () => {
  const ticks = problemTicks(
    [
      { at: at(100), level: 'log', source: 'console', text: 'hi' },
      { at: at(200), level: 'warn', source: 'console', text: 'warn' },
      { at: at(300), level: 'error', source: 'console', text: 'boom' },
      { at: at(400), level: 'error', source: 'pageerror', text: 'page boom' },
    ],
    [
      {
        at: at(500),
        method: 'POST',
        url: 'http://x.test/api/login?token=1',
        resourceType: 'xhr',
        status: 500,
        failed: false,
        durationMs: 12,
      },
      {
        at: at(600),
        method: 'GET',
        url: 'http://x.test/api/page',
        resourceType: 'xhr',
        status: null,
        failed: true,
        durationMs: null,
      },
      {
        at: at(700),
        method: 'GET',
        url: 'http://x.test/ok',
        resourceType: 'xhr',
        status: 200,
        failed: false,
        durationMs: 8,
      },
    ],
    range,
  );
  assert.deepEqual(
    ticks.map((tick) => tick.leftPct),
    [15, 20, 25, 30],
  );
  assert.match(ticks[0].title, /Console 错误：boom/);
  assert.match(ticks[1].title, /页面脚本异常/);
  // Titles never leak a query string.
  assert.equal(ticks[2].title.includes('token'), false);
  assert.match(ticks[3].title, /请求失败/);
});

test('reproduction markers are numbered, clamped and carry the step text', () => {
  const markers = reproMarkers(
    [
      { index: 2, at: at(1000) },
      { index: 1, at: at(200) },
      { index: 3, at: at(9000) },
    ],
    ['打开登录页', '输入账号', '点击登录'],
    range,
  );
  assert.deepEqual(
    markers.map((marker) => [marker.index, marker.leftPct]),
    [
      [1, 10],
      [2, 50],
    ],
  );
  assert.match(markers[0].title, /第 1 步：打开登录页/);
  assert.match(markers[1].title, /第 2 步：输入账号/);
});

test('console and network filters cover what the tabs offer', () => {
  const consoleLines = [
    { at: at(1), level: 'log', source: 'console', text: '页面加载完成' },
    { at: at(2), level: 'error', source: 'console', text: 'boom' },
    { at: at(3), level: 'error', source: 'pageerror', text: 'TypeError: x' },
  ];
  assert.equal(filterConsole(consoleLines, {}).length, 3);
  assert.equal(filterConsole(consoleLines, { level: 'error' }).length, 2);
  assert.equal(filterConsole(consoleLines, { query: 'BOOM' }).length, 1);
  assert.equal(
    filterConsole(consoleLines, { level: 'error', query: 'typeerror' }).length,
    1,
  );

  const networkLines = [
    {
      at: at(1),
      method: 'GET',
      url: 'http://x.test/api/pageUsers?page=1',
      resourceType: 'xhr',
      status: 200,
      failed: false,
      durationMs: 10,
    },
    {
      at: at(2),
      method: 'POST',
      url: 'http://x.test/api/login',
      resourceType: 'xhr',
      status: 500,
      failed: false,
      durationMs: 20,
    },
    {
      at: at(3),
      method: 'GET',
      url: 'http://x.test/assets/a.png',
      resourceType: 'image',
      status: null,
      failed: true,
      durationMs: null,
    },
  ];
  assert.equal(filterNetwork(networkLines, {}).length, 3);
  assert.equal(filterNetwork(networkLines, { onlyFailed: true }).length, 1);
  assert.equal(filterNetwork(networkLines, { method: 'post' }).length, 1);
  assert.equal(filterNetwork(networkLines, { status: '5xx' }).length, 1);
  assert.equal(filterNetwork(networkLines, { status: 'failed' }).length, 1);
  assert.equal(
    filterNetwork(networkLines, { resourceType: 'image' }).length,
    1,
  );
  assert.equal(filterNetwork(networkLines, { query: 'pageusers' }).length, 1);
  assert.equal(networkName(networkLines[0].url), 'pageUsers');
  assert.equal(shortUrl(networkLines[0].url), 'http://x.test/api/pageUsers');
});

test('the four recording states never fabricate a playable replay', () => {
  const base = {
    taskId: 'task_1',
    rrwebArtifactId: null,
    consoleArtifactId: null,
    networkArtifactId: null,
    startedAt: null,
    endedAt: null,
    viewport: null,
    error: null,
  };
  assert.deepEqual(
    [recordingStatusView({ ...base, status: 'recording' }).playable],
    [false],
  );
  assert.equal(
    recordingStatusView({ ...base, status: 'recording' }).label,
    '录制中',
  );
  assert.equal(
    recordingStatusView({ ...base, status: 'available' }).playable,
    true,
  );
  const degraded = recordingStatusView({
    ...base,
    status: 'degraded',
    rrwebArtifactId: 'artifact_1',
    error: '录制达到 20 MB 上限',
  });
  assert.equal(degraded.playable, true);
  assert.match(degraded.detail, /录像不完整：录制达到 20 MB 上限/);
  const missing = recordingStatusView({ ...base, status: 'missing' });
  assert.equal(missing.playable, false);
  assert.match(missing.detail, /没有可回放的录像/);
  assert.equal(recordingStatusView(null).playable, false);
  assert.match(
    recordingStatusView({ ...base, status: 'available' }, '下载失败').detail,
    /下载失败/,
  );
});

test('a malformed recording answer degrades to missing instead of crashing', () => {
  assert.equal(normalizeRecording(null, 'task_9').status, 'missing');
  assert.equal(normalizeRecording({}, 'task_9').status, 'missing');
  assert.equal(
    normalizeRecording({ status: 'weird' }, 'task_9').status,
    'missing',
  );
  const normalized = normalizeRecording(
    {
      taskId: 'task_9',
      status: 'degraded',
      rrwebArtifactId: 'artifact_9',
      viewport: { width: 1280, height: 720 },
      error: '',
    },
    'task_9',
  );
  assert.equal(normalized.rrwebArtifactId, 'artifact_9');
  assert.deepEqual(normalized.viewport, { width: 1280, height: 720 });
  assert.equal(normalized.error, null, 'an empty error is no error');
});

test('the real gzipped rrweb evidence is readable', async () => {
  const binary = Buffer.from(MOCK_RRWEB_GZIP_BASE64, 'base64');
  assert.deepEqual([...binary.slice(0, 2)], [0x1f, 0x8b], 'gzip magic');
  const events = await readJsonBlob(new Blob([binary]));
  assert.equal(Array.isArray(events), true);
  assert.equal(events.length, 29);
  const meta = events.find((event) => event.type === 4);
  assert.equal(meta.data.href, 'http://192.168.111.114:38445/login');
  assert.equal(meta.data.width, 1280);
  assert.equal(
    events.some((event) => event.type === 2),
    true,
    'full snapshot',
  );
  // Plain JSON is accepted too, and garbage is a readable error.
  assert.deepEqual(await readJsonBlob(new Blob(['[1,2]'])), [1, 2]);
  await assert.rejects(readJsonBlob(new Blob(['not json'])), /不是合法的 JSON/);
});

test('clock, url-at-time and step ordering helpers behave', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(152_000), '2:32');
  assert.equal(formatClock(1_999), '0:01', 'floored, like the player');
  assert.equal(formatClock(1_860), '0:01');
  assert.equal(formatClock(-5), '0:00');
  const metas = [
    { at: start, href: 'http://x.test/login' },
    { at: start + 1000, href: 'http://x.test/home' },
  ];
  assert.equal(urlAt(metas, start - 1), null);
  assert.equal(urlAt(metas, start + 10), 'http://x.test/login');
  assert.equal(urlAt(metas, start + 1500), 'http://x.test/home');
  assert.deepEqual(
    sortSteps([{ seq: 2 }, { seq: 1 }, { seq: 3 }]).map((step) => step.seq),
    [1, 2, 3],
  );
});

test('degraded evidence still replays, with its own reason', () => {
  const base = { status: 'available', redaction: 'applied', error: null };
  assert.deepEqual(evidencePolicy(base), { download: true, warning: null });
  // A recording cut at the size cap is short, not broken: play it and say so.
  assert.deepEqual(
    evidencePolicy({
      ...base,
      status: 'degraded',
      error: '录制达到 20 MB 上限，已截断到前 1.8 秒',
    }),
    { download: true, warning: '录制达到 20 MB 上限，已截断到前 1.8 秒' },
  );
  // Degraded without a reason still plays, with a generic hint.
  assert.deepEqual(evidencePolicy({ ...base, status: 'degraded' }), {
    download: true,
    warning: '录像证据不完整（录制被截断）',
  });
  assert.deepEqual(
    evidencePolicy({ ...base, status: 'degraded', error: '   ' }),
    { download: true, warning: '录像证据不完整（录制被截断）' },
    'a blank reason is no reason',
  );
});

test('missing or failed evidence is refused with the artifact message', () => {
  const base = { status: 'available', redaction: 'applied', error: null };
  for (const status of ['missing', 'failed']) {
    assert.deepEqual(evidencePolicy({ ...base, status }), {
      download: false,
      reason: '录像证据不可用',
    });
    assert.deepEqual(
      evidencePolicy({ ...base, status, error: '写入证据时磁盘已满' }),
      { download: false, reason: '写入证据时磁盘已满' },
    );
  }
});

test('a failed redaction is never downloaded, whatever the status', () => {
  for (const status of ['available', 'degraded', 'missing', 'failed']) {
    const decision = evidencePolicy({
      status,
      redaction: 'failed',
      error: '脱敏超时',
    });
    assert.equal(decision.download, false, status);
    assert.match(decision.reason, /脱敏/);
  }
  // not_needed is the same as applied.
  assert.equal(
    evidencePolicy({
      status: 'available',
      redaction: 'not_needed',
      error: null,
    }).download,
    true,
  );
});
