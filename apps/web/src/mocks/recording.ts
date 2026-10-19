import type {
  ConsoleEntry,
  NetworkEntry,
  Step,
  TaskRecording,
} from '@localqa/contracts';

/**
 * A real rrweb recording of a small login page, captured with rrweb@2.1.7
 * (maskAllInputs, no canvas, inline styles) and gzipped exactly like the Worker
 * stores evidence: 29 events, 1.8 s, 1280 × 720. The page types into the account
 * field and clicks 登录, so the player has a full snapshot plus incremental
 * events to replay.
 */
export const MOCK_RRWEB_GZIP_BASE64 = [
  'H4sIAAAAAAACE8WYzW7bRhDHX8XYY8HKu8uPJXUr3AA1ECRBmpsbFLS4MtlSJEGunBiCAAdBnBQ9xGjTQ3poWqBJenICtKhR',
  'C02BPksoqW/R5cdSsRTaSwpFD4YoUju//8zOzA69MwLsIKKgqynAsZkNuiPgxrQPusBlLOpubiILd5BhdhBC/E/rqqam6Zt+',
  'uOcFQAF3PIe5oIuwCRXgUm/PZaBLMBwrgHkDmjB7EPHHxMIqIQSpuo7GimDiBTMIHZp9Fg+4rZ7r+c41fjcB3R1xHykgsAc0',
  'FzfwOT4a7vpeb9vhd/i35CBhdCC+efwTn4Mxe+/aueU2Y7G3O2QZZDSugZ5fSG2n1cIB5Y4uLeTL7DihPGJgyPofmmDZ0u3C',
  'C73GC+Yxn8qqUflKepdthQGjQYacPZ2kf3638ffpRnr0zez+szJkZFxSjRpq0ou9iK34UvwyZ2x+Ye/b5c+k5Xy6dXP7xq3P',
  'b1z9aOvKJ9evfnzlZinIEoJMcaEtlK2Y+SwolyFYo383dA7abaGdp3yLpEGtN2n67Mn08OXs3uv07MXs5KfZ8VH6x6/p49fC',
  'SU3EBKlSQalLpX4YD1r55nj7rdZ5QTRcTaJMI7B7vXAYZA8j3+5RN/QdGvP781en8zffpg+ez397kT4+rasWVOUJIlIxsWpi',
  '8h+4FtlJcieMsxZS1ss7d2q8TV8dzX68V+ctRsJbDGW8xXUtkQtlYVBX1tXT3I2i+zfpNBu81QgFVc5itdopQ0p7XfYO/feH',
  'e0CDIZDaM99rXaLpyVfpg1/enn39dvL79HAyf/lIyK0SEZMa4Wtg5ydv0p8fzv86nh8/Tx8dTX84LrEqrLBV68RS8VWRfCUU',
  'AXa9vE5dz3FokB278vKXirlUUGWEiqUUa40OqfUPI9WoBOpV8uLqqirGRWZzphd4zLP96/1+ftiPgE/7LJ9yWMinIziun5bO',
  'dzAxLSXhMO4V81AUJtx4GBTu3OWnJJ/kDvipaYpuWNgWcJ4cNTQNQnQhDSuLMUyYzoEdvUR2VAIhxEQzdBNDtR6kyYH0qqPX',
  'WtLlLMG1JZtyILwEqjYjCnmt0PhWIactRy8ylafoB1lGJlsu7X1JObBv+wm9NFzYkrXeyjxB0ubb2OevH/L2WwF0owGgFcEy',
  'mxDaILAGGyFaMUy1GaMNRMVGQ0grCoFNKW0w2iW5+75WrqK8e/Bwi3lJupcTojfq5ZnpnNhBJu+HUIU6IjoxhYCOaliWpSNE',
  'kJmZXpNqXBYuaUt6NUquawn+L5HAS9TFjssdGJeBYJG+5RvDu9PQzqgctJYnOzHNBUPfH2dzTEwH4b546bAdp1gc2TEflrbz',
  '6VIBAYdk19kiZenfOQ1HXjFCkXHm2QKjkosxqy/PT0/+Ofx++mSSPpxMz6r52BxfVDdG4zI1DJjvGh8fxNwtW6e6Bq1mdWop',
  'S8iOKZGPuoZgo8qsrSd5S3BdxahZBa1wJEsoJ93+F3PYy9MJFQAA',
].join('');

/** The task the mock recording belongs to (a reproducer of the calc defect). */
export const MOCK_RECORDING_TASK_ID = 'task_mock_repro_01';
export const MOCK_RECORDING_RUN_ID = 'run_mock_001_completed';
export const MOCK_RRWEB_ARTIFACT_ID = 'artifact_mock_rrweb_01';
export const MOCK_CONSOLE_ARTIFACT_ID = 'artifact_mock_console_01';
export const MOCK_NETWORK_ARTIFACT_ID = 'artifact_mock_network_01';

/** First and last event timestamps of the fixture. */
export const MOCK_RECORDING_STARTED_AT = '2026-10-19T02:41:53.551Z';
export const MOCK_RECORDING_ENDED_AT = '2026-10-19T02:41:55.411Z';

export const mockRecordingInfo: TaskRecording = {
  taskId: MOCK_RECORDING_TASK_ID,
  status: 'available',
  rrwebArtifactId: MOCK_RRWEB_ARTIFACT_ID,
  consoleArtifactId: MOCK_CONSOLE_ARTIFACT_ID,
  networkArtifactId: MOCK_NETWORK_ARTIFACT_ID,
  startedAt: MOCK_RECORDING_STARTED_AT,
  endedAt: MOCK_RECORDING_ENDED_AT,
  viewport: { width: 1280, height: 720 },
  error: null,
};

const at = (offsetMs: number): string =>
  new Date(Date.parse(MOCK_RECORDING_STARTED_AT) + offsetMs).toISOString();

/**
 * A recording that hit the 20 MB cap: the recorder cut it short, so the
 * artifact is `degraded` while the part that was recorded still replays. The
 * player must say why instead of refusing to play (`evidencePolicy`).
 */
export const MOCK_DEGRADED_TASK_ID = 'task_mock_exec_20_2';
export const MOCK_RRWEB_DEGRADED_ARTIFACT_ID =
  'artifact_mock_rrweb_degraded_01';
export const MOCK_RRWEB_DEGRADED_ERROR =
  '录制达到 20 MB 上限，已截断到前 1.8 秒';

export const mockDegradedRecordingInfo: TaskRecording = {
  ...mockRecordingInfo,
  taskId: MOCK_DEGRADED_TASK_ID,
  status: 'degraded',
  rrwebArtifactId: MOCK_RRWEB_DEGRADED_ARTIFACT_ID,
  error: MOCK_RRWEB_DEGRADED_ERROR,
};

export const mockConsoleLines: ConsoleEntry[] = [
  { at: at(120), level: 'log', source: 'console', text: '页面加载完成' },
  {
    at: at(900),
    level: 'warn',
    source: 'console',
    text: 'Element Plus: 组件重复注册 [ElScrollbar]',
  },
  {
    at: at(1180),
    level: 'error',
    source: 'console',
    text: "Uncaught TypeError: Cannot read properties of undefined (reading 'total')",
  },
  {
    at: at(1190),
    level: 'error',
    source: 'pageerror',
    text: 'TypeError: 列表分页 total 为 undefined',
  },
  {
    at: at(1500),
    level: 'info',
    source: 'console',
    text: '输入账号 smoke_user',
  },
];

/**
 * Two lines per request for the first four requests — one when the recorder sees
 * the request start (`status: null`), one when it finishes — which is what the
 * 66 recordings contain; the last one is already a single line. The player has to
 * pair them into one row either way.
 */
export const mockNetworkLines: NetworkEntry[] = [
  {
    at: at(40),
    method: 'GET',
    url: 'http://192.168.111.114:38445/login',
    resourceType: 'document',
    status: null,
    failed: false,
    durationMs: null,
  },
  {
    at: at(60),
    method: 'GET',
    url: 'http://192.168.111.114:38445/login',
    resourceType: 'document',
    status: 200,
    failed: false,
    durationMs: 180,
  },
  {
    at: at(400),
    method: 'GET',
    url: 'http://192.168.111.114:38445/api/fc-rx-auth/v1/internal/digitalAuthSetting',
    resourceType: 'xhr',
    status: null,
    failed: false,
    durationMs: null,
  },
  {
    at: at(420),
    method: 'GET',
    url: 'http://192.168.111.114:38445/api/fc-rx-auth/v1/internal/digitalAuthSetting',
    resourceType: 'xhr',
    status: 200,
    failed: false,
    durationMs: 96,
  },
  {
    at: at(690),
    method: 'POST',
    url: 'http://192.168.111.114:38445/api/fc-rx-auth/v1/user/login',
    resourceType: 'xhr',
    status: null,
    failed: false,
    durationMs: null,
  },
  {
    at: at(700),
    method: 'POST',
    url: 'http://192.168.111.114:38445/api/fc-rx-auth/v1/user/login',
    resourceType: 'xhr',
    status: 500,
    failed: false,
    durationMs: 240,
  },
  {
    at: at(1080),
    method: 'GET',
    url: 'http://192.168.111.114:38445/api/fc-admin/v1/pageUsers',
    resourceType: 'xhr',
    status: null,
    failed: false,
    durationMs: null,
  },
  {
    at: at(1100),
    method: 'GET',
    url: 'http://192.168.111.114:38445/api/fc-admin/v1/pageUsers',
    resourceType: 'xhr',
    status: 404,
    failed: true,
    durationMs: 210,
    summary: 'GET /api/fc-admin/v1/pageUsers → 请求失败',
  },
  {
    at: at(1600),
    method: 'GET',
    url: 'http://192.168.111.114:38445/assets/login-frame.9c7af97c.png',
    resourceType: 'image',
    status: 200,
    failed: false,
    durationMs: 54,
  },
];

export type MockRecordingStep = Step & { runId: string };

const step = (
  seq: number,
  toolName: string,
  summary: string,
  offsetMs: number,
  durationMs: number,
  thought: string | null,
): MockRecordingStep => ({
  id: `step_mock_recording_${String(seq).padStart(2, '0')}`,
  runId: MOCK_RECORDING_RUN_ID,
  taskId: MOCK_RECORDING_TASK_ID,
  caseId: null,
  seq,
  toolName,
  status: 'succeeded',
  summary,
  targetDescription: '',
  evidenceRefs: [],
  createdAt: at(offsetMs),
  finishedAt: at(offsetMs + durationMs),
  thought,
});

/** Activity rows and the Steps timeline of the mock recording. */
export const mockRecordingSteps: MockRecordingStep[] = [
  step(1, 'navigate', '打开登录页', 0, 380, '先确认登录页能打开，再开始复现。'),
  step(2, 'click', '点击账号输入框', 400, 120, '聚焦账号输入框。'),
  step(
    3,
    'type_text',
    '输入账号 smoke_user',
    540,
    360,
    '用虚构账号触发登录校验。',
  ),
  step(4, 'click', '点击登录', 920, 260, '空密码提交，观察必填提示。'),
  step(
    5,
    'observe',
    '观察登录后的页面',
    1200,
    200,
    '提示出现了，记录当前页面。',
  ),
  step(6, 'capture', '保存截图证据', 1500, 120, '保存一张截图作为证据。'),
];

/** Reproduction marks inside the mock recording (1-based step indexes). */
export const mockReproMarks = [
  { index: 1, at: at(300) },
  { index: 2, at: at(860) },
  { index: 3, at: at(1240) },
];

export const mockReproSteps = [
  '打开 http://192.168.111.114:38445/login',
  '在账号框输入 smoke_user，密码留空',
  '点击「登录」，页面停在登录页且未提示请输入密码',
];
