import { randomBytes, createHash } from 'node:crypto';
import https from 'node:https';
import {
  readFileSync,
  mkdirSync,
  statSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export async function runAcceptanceExtras({
  cmd,
  http,
  record,
  deploy,
  root,
  cookie,
  adminPassword,
  project,
  model,
  run,
  final,
  sandbox,
  statuses,
}) {
  const sql = (query) =>
    cmd('docker', [
      'exec',
      'localqa-postgres',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'localqa',
      '-d',
      'localqa',
      '-Atc',
      query,
    ]).stdout.trim();
  const section = async (name, work) => {
    try {
      await work();
    } catch (error) {
      record(
        name,
        '失败',
        { error: String(error) },
        '本项执行失败，不视作通过',
      );
    }
  };
  await section('1_six_services_business', async () => {
    const [web, api, db] = await Promise.all([
      http('GET', '/', null, cookie),
      http('GET', '/api/v1/projects', null, cookie),
      Promise.resolve(sql('SELECT count(*) FROM storage_migrations')),
    ]);
    const raw = {
      compose: statuses,
      gatewayWeb: {
        status: web.status,
        contentType: web.headers['content-type'],
        containsLocalQA: String(web.json).includes('LocalQA'),
      },
      gatewayApi: { status: api.status, projects: api.json?.items?.length },
      postgresMigrations: db,
      orchestratorJobCount: sql(
        `SELECT count(*) FROM jobs WHERE run_id='${run.id}' AND status='succeeded'`,
      ),
      workerLeasedJobCount: sql(
        `SELECT count(*) FROM jobs WHERE run_id='${run.id}' AND worker_id IS NOT NULL`,
      ),
      chromium: sandbox,
    };
    const passed =
      statuses.every((s) => s.health === 'healthy') &&
      web.status === 200 &&
      api.status === 200 &&
      Number(db) === 5 &&
      Number(raw.orchestratorJobCount) >= 4 &&
      Number(raw.workerLeasedJobCount) >= 4 &&
      sandbox.processes.every((p) => p.seccomp === 2 && !p.noSandbox);
    record(
      '1_six_services_business',
      passed ? '通过' : '失败',
      raw,
      passed ? null : '健康或业务链路不满足',
      6,
    );
  });

  let users = [];
  await section('3_multi_user_quota', async () => {
    const roles = Array.from({ length: 9 }, (_, i) =>
      i < 3 ? 'owner' : i < 6 ? 'operator' : 'viewer',
    );
    const password = `T09-${randomBytes(18).toString('hex')}!`;
    const created = [];
    for (let i = 0; i < 9; i++) {
      const res = await http(
        'POST',
        '/api/v1/users',
        {
          email: `accept-${i}@localqa.internal`,
          displayName: `Acceptance ${i}`,
          password,
          globalRole: 'member',
        },
        cookie,
      );
      created.push({
        index: i,
        status: res.status,
        id: res.json?.id,
        role: roles[i],
      });
    }
    if (created.some((x) => x.status !== 201))
      throw new Error(`User creation results: ${JSON.stringify(created)}`);
    const owner = (
      await http('GET', `/api/v1/projects/${project.id}`, null, cookie)
    ).json;
    const members = await http(
      'PUT',
      `/api/v1/projects/${project.id}/members`,
      {
        expectedVersion: owner.version,
        members: [
          { userId: final.creatorId, role: 'owner' },
          ...created.map((u) => ({ userId: u.id, role: u.role })),
        ],
      },
      cookie,
    );
    // The actor ID is fetched from the login response if the run's creator is not exposed.
    const beta = await http(
      'POST',
      '/api/v1/projects',
      { name: 'Acceptance isolation project' },
      cookie,
    );
    const betaDefault =
      beta.status === 201
        ? await http(
            'PATCH',
            `/api/v1/projects/${beta.json.id}`,
            {
              expectedVersion: beta.json.version,
              defaultModelProfileId: model.id,
            },
            cookie,
          )
        : null;
    const logins = await Promise.all(
      created.map((u) =>
        http(
          'POST',
          '/api/v1/auth/login',
          { email: `accept-${u.index}@localqa.internal`, password },
          null,
        ),
      ),
    );
    users = logins.map((res, i) => ({
      index: i,
      role: roles[i],
      status: res.status,
      cookie: Array.isArray(res.headers?.['set-cookie'])
        ? String(res.headers['set-cookie'][0]).split(';')[0]
        : null,
    }));
    const results = await Promise.all(
      [{ role: 'admin', cookie }, ...users].map(async (u) => ({
        role: u.role,
        self: (await http('GET', '/api/v1/auth/me', null, u.cookie)).status,
        alpha: (
          await http('GET', `/api/v1/projects/${project.id}`, null, u.cookie)
        ).status,
        beta:
          u.role === 'admin'
            ? null
            : (
                await http(
                  'GET',
                  `/api/v1/projects/${beta.json.id}`,
                  null,
                  u.cookie,
                )
              ).status,
      })),
    );
    const viewer = users.find((u) => u.role === 'viewer');
    const deniedRun = viewer?.cookie
      ? await http(
          'POST',
          '/api/v1/runs',
          {
            projectId: project.id,
            targetUrl: 'http://localqa-t09b-fixture:8080/',
          },
          viewer.cookie,
        )
      : null;
    const raw = {
      usersCreated: created.map(({ index, status, role }) => ({
        index,
        status,
        role,
      })),
      memberPut: members.status,
      logins: users.map(({ index, status, role }) => ({ index, status, role })),
      concurrentGets: results,
      viewerRun: deniedRun && {
        status: deniedRun.status,
        code: deniedRun.json?.code,
      },
      betaCreation: beta.status,
      betaDefault: betaDefault?.status,
      slotConfiguration:
        'BROWSER_SLOTS=4; projectSlots=4; run concurrency budget defaults to 2',
    };
    const rbac =
      members.status === 200 &&
      beta.status === 201 &&
      betaDefault?.status === 200 &&
      users.every((u) => u.status === 200) &&
      results.every(
        (r) =>
          r.self === 200 &&
          r.alpha === 200 &&
          (r.role === 'admin' || r.beta === 404),
      ) &&
      deniedRun?.status === 403;
    record(
      '3_ten_users_rbac',
      rbac ? '通过' : '失败',
      raw,
      rbac ? null : '10 用户并发/RBAC 观察与预期不符',
      10,
    );
    // Real jobs only: no synthetic reservations for fairness. Quick fixture may not saturate four slots.
    const started = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        http(
          'POST',
          '/api/v1/runs',
          {
            projectId: i % 2 ? beta.json.id : project.id,
            targetUrl: 'http://localqa-t09b-fixture:8080/',
          },
          cookie,
        ),
      ),
    );
    const snapshots = [];
    for (let i = 0; i < 35; i++) {
      snapshots.push(
        sql(
          "SELECT count(*)||'|'||count(DISTINCT project_id)||'|'||coalesce(max((reserved->>'concurrency')::int),0) FROM budget_reservations WHERE kind='concurrency' AND status='reserved'",
        ),
      );
      await delay(100);
    }
    const accepted = started.filter((r) => r.status === 202);
    const ids = accepted.map((r) => r.json.id);
    const finishStates = [];
    for (let i = 0; i < 45; i++) {
      const states = ids.length
        ? sql(
            `SELECT status||':'||count(*) FROM runs WHERE id IN (${ids.map((id) => `'${id}'`).join(',')}) GROUP BY status ORDER BY status`,
          )
        : '';
      finishStates.push(states);
      if (states === `completed:${ids.length}`) break;
      await delay(1000);
    }
    const max = Math.max(...snapshots.map((s) => Number(s.split('|')[0])));
    const rawSlots = {
      requestStatuses: started.map((r) => ({
        status: r.status,
        code: r.json?.code,
      })),
      accepted: ids.length,
      samples: snapshots.length,
      maxActiveReservations: max,
      firstSnapshots: snapshots.slice(0, 12),
      lastFinishState: finishStates.at(-1),
      projects: [project.id, beta.json?.id],
    };
    record(
      '3_four_slots_fairness',
      started.some((r) => r.status !== 202) ? '失败' : '未验证',
      rawSlots,
      started.some((r) => r.status !== 202)
        ? '四槽饱和时新请求遭拒，未实现要求的排队公平性；已记录真实请求。'
        : '八运行完成也不能证明长期公平，需带排队时间的三级限额观测。',
      snapshots.length,
    );
  });

  await section('5_performance', async () => {
    const samples = [];
    for (let i = 0; i < 100; i++) {
      const begin = performance.now();
      const res = await http(
        'GET',
        `/api/v1/projects/${project.id}`,
        null,
        cookie,
      );
      samples.push({
        ms: Number((performance.now() - begin).toFixed(2)),
        status: res.status,
      });
    }
    const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    record(
      '5_api_p95',
      samples.every((s) => s.status === 200) && p95 <= 500 ? '通过' : '失败',
      {
        count: samples.length,
        p95Ms: p95,
        minMs: sorted[0],
        maxMs: sorted.at(-1),
        samples,
        hardwareCaveat:
          'Current host/VM resource budget must be compared with design reference 16 vCPU/32GiB/SSD',
      },
      null,
      samples.length,
    );
    record(
      '5_event_to_ui_p95',
      '未验证',
      { count: 0 },
      '未建立同一时钟的数据库提交→真实 UI DOM 呈现时间戳；不能把 SSE 到达时间替代 UI 指标。',
      0,
    );
  });

  await section('4_sse_reconnect', async () => {
    const maxSeq = Number(
      sql(`SELECT max(seq) FROM run_events WHERE run_id='${run.id}'`),
    );
    const readFrames = (cursor, count) =>
      new Promise((resolve, reject) => {
        const req = https.request(
          {
            host: '127.0.0.1',
            port: 18443,
            servername: 'localqa.internal',
            path: `/api/v1/runs/${run.id}/events`,
            ca: readFileSync(`${deploy}/certs/tls.crt`),
            headers: {
              Host: 'localqa.internal',
              Cookie: cookie,
              'Last-Event-ID': String(cursor),
            },
          },
          (res) => {
            if (res.statusCode !== 200) {
              reject(new Error(`SSE status ${res.statusCode}`));
              res.resume();
              return;
            }
            let data = '';
            res.on('data', (chunk) => {
              data += chunk.toString();
              const ids = [...data.matchAll(/^id: (\d+)$/gm)].map((m) =>
                Number(m[1]),
              );
              if (ids.length >= count) {
                req.destroy();
                resolve({
                  status: res.statusCode,
                  ids,
                  raw: data.slice(0, 1500),
                });
              }
            });
          },
        );
        req.setTimeout(4000, () => req.destroy(new Error('SSE read timeout')));
        req.on('error', reject);
        req.end();
      });
    const first = await readFrames(maxSeq - 3, 3);
    const second = await readFrames(first.ids.at(-2), 1);
    const ok =
      first.ids.join(',') === [maxSeq - 2, maxSeq - 1, maxSeq].join(',') &&
      second.ids[0] === maxSeq;
    record(
      '4_sse_reconnect',
      ok ? '通过' : '失败',
      { maxSeq, first, second },
      '预期：Last-Event-ID 后续帧无漏序；浏览器 UI 状态恢复另测。',
      2,
    );
  });

  await section('6_ui', async () => {
    const screenshots = `${root}/deploy/.evidence`;
    mkdirSync(screenshots, { recursive: true, mode: 0o700 });
    const output = `${screenshots}/T09B-ui-real.png`;
    const credentialFile = `${screenshots}/acceptance-ui-input.json`;
    writeFileSync(
      credentialFile,
      JSON.stringify({
        email: 'admin@localqa.internal',
        password: adminPassword,
        runId: run.id,
        screenshot: output,
      }),
      { mode: 0o600 },
    );
    const script = `const fs=await import('node:fs/promises'); const input=JSON.parse(await fs.readFile('${credentialFile}','utf8')); const task = await taskSpace('T09-B P0 real UI'); const page=task.page('p1'); let result={spaceId:task.spaceId}; try { await page.cdp('Security.setIgnoreCertificateErrors',{ignore:true}); await page.goto('https://127.0.0.1:18443/'); result.initial=String(await page.snapshot()).slice(0,2500); await page.fill('[data-testid="login-username-input"]',input.email); await page.fill('[data-testid="login-password-input"]',input.password); await page.click('button[type=submit]'); result.afterLogin=String(await page.snapshot()).slice(0,3000); await page.goto('https://127.0.0.1:18443/#/workbench?runId='+input.runId); result.beforeRefresh=String(await page.snapshot()).slice(0,3500); await page.reload(); result.afterRefresh=String(await page.snapshot()).slice(0,3500); result.mock=await page.evaluate(()=>localStorage.getItem('LOCALQA_USE_MOCK')); result.screenshot=await page.screenshot({path:input.screenshot}); } catch(e){result.error=String(e)} console.log('ACCEPT_UI_JSON '+JSON.stringify(result)); await task.finish({keep:[]});`;
    let out;
    try {
      out = spawnSync('ego-browser', ['nodejs', '-e', script], {
        cwd: root,
        encoding: 'utf8',
        timeout: 90000,
        maxBuffer: 1024 * 1024,
        env: process.env,
      });
    } finally {
      rmSync(credentialFile, { force: true });
    }
    const match = (out.stderr || out.stdout)?.match(
      /ACCEPT_UI_JSON (\{[^\n]+\})/,
    );
    const result = match ? JSON.parse(match[1]) : null;
    const raw = {
      exitCode: out.status,
      stdout: out.stdout?.slice(-5500),
      stderr: out.stderr?.slice(-6500),
      result,
      screenshot: result?.screenshot && {
        path: 'deploy/.evidence/T09B-ui-real.png',
        bytes: statSync(output).size,
        sha256: createHash('sha256').update(readFileSync(output)).digest('hex'),
      },
    };
    const valid =
      out.status === 0 &&
      result?.screenshot &&
      !result?.error &&
      result?.mock !== 'true' &&
      result?.afterRefresh?.includes(run.id);
    record(
      '6_ui_refresh',
      valid ? '通过' : '失败',
      raw,
      valid ? null : '不能用截图存在替代刷新位置、真实后端与 SSE 恢复断言。',
      1,
    );
    record(
      '6_ui_sse_partial_blocked',
      '未验证',
      {
        screenshot: raw.screenshot || null,
        disconnectEvents: 0,
        partialScreenshots: 0,
        blockedScreenshots: 0,
      },
      '未获得真实断线重连和 partial/受阻状态截图，不复用 mock 画面。',
      0,
    );
  });

  await section('4_faults', async () => {
    const before = await http('GET', `/api/v1/runs/${run.id}`, null, cookie);
    const restart = cmd('docker', ['restart', 'localqa-postgres'], true);
    let recovered = null;
    for (let i = 0; i < 30; i++) {
      try {
        recovered = await http(
          'GET',
          `/api/v1/runs/${run.id}`,
          null,
          cookie,
          2500,
        );
        if (recovered.status === 200) break;
      } catch {
        /* genuine outage */
      }
      await delay(1000);
    }
    const after = {
      before: before.status,
      dockerRestartExit: restart.status,
      after: recovered?.status,
      persistedStatus: recovered?.json?.status,
    };
    record(
      '4_db_restart',
      before.status === 200 &&
        restart.status === 0 &&
        recovered?.status === 200 &&
        recovered.json?.id === run.id
        ? '通过'
        : '失败',
      after,
      '预期：已提交运行保留、API 恢复可读；在途动作语义未覆盖。',
      1,
    );
    const next = await http(
      'POST',
      '/api/v1/runs',
      { projectId: project.id, targetUrl: 'http://localqa-t09b-fixture:8080/' },
      cookie,
    );
    let runningJob = null;
    if (next.status === 202) {
      for (let i = 0; i < 30; i++) {
        runningJob = sql(
          `SELECT id FROM jobs WHERE run_id='${next.json.id}' AND status='running' LIMIT 1`,
        );
        if (runningJob) break;
        await delay(50);
      }
    }
    const killed = runningJob
      ? cmd('docker', ['kill', '--signal', 'KILL', 'localqa-worker'], true)
      : null;
    let recoveredWorker = null;
    for (let i = 0; i < 25 && killed?.status === 0; i++) {
      recoveredWorker = cmd(
        'docker',
        ['inspect', '-f', '{{.State.Health.Status}}', 'localqa-worker'],
        true,
      ).stdout.trim();
      if (recoveredWorker === 'healthy') break;
      await delay(1000);
    }
    const workerRaw = {
      newRun: next.status,
      runningJob: runningJob || null,
      killExit: killed?.status ?? null,
      restartedHealth: recoveredWorker,
      authoritativeRun: next.json?.id
        ? (await http('GET', `/api/v1/runs/${next.json.id}`, null, cookie)).json
            ?.status
        : null,
    };
    const workerLogs = cmd(
      'docker',
      ['logs', '--tail', '35', 'localqa-worker'],
      true,
    );
    workerRaw.workerLogs = (workerLogs.stderr + workerLogs.stdout).slice(-3000);
    record(
      '4_worker_midtask_kill',
      !runningJob
        ? '未验证'
        : killed?.status === 0 && recoveredWorker === 'healthy'
          ? '未验证'
          : '失败',
      workerRaw,
      !runningJob
        ? '未命中在途 lease。'
        : recoveredWorker !== 'healthy'
          ? '杀死在途 Worker 后未能于 25 秒内恢复就绪；旧 fencing/unknown intent 另需复核。'
          : '进程恢复健康，但旧 fencing/unknown intent 不重放及任务收敛仍未逐字段验证。',
      1,
    );
    record(
      '4_disk_full',
      '未验证',
      { bytesWritten: 0, target: 'persistent data volume' },
      '不在共享 Docker VM 上填满持久卷；没有隔离容量限制/独立测试磁盘，未注入 ENOSPC。',
      0,
    );
    const patch = await http(
      'PATCH',
      `/api/v1/model-profiles/${model.id}`,
      { expectedVersion: model.version, status: 'disabled' },
      cookie,
    );
    const disabledRun = await http(
      'POST',
      '/api/v1/runs',
      { projectId: project.id, targetUrl: 'http://localqa-t09b-fixture:8080/' },
      cookie,
    );
    let state = null;
    if (disabledRun.status === 202)
      for (let i = 0; i < 20; i++) {
        state = await http(
          'GET',
          `/api/v1/runs/${disabledRun.json.id}`,
          null,
          cookie,
        );
        if (
          ['completed', 'failed', 'cancelled', 'awaiting_input'].includes(
            state.json?.status,
          )
        )
          break;
        await delay(500);
      }
    const revokeRaw = {
      patchStatus: patch.status,
      patchBody: patch.json,
      createStatus: disabledRun.status,
      createBody: disabledRun.json && {
        id: disabledRun.json.id,
        status: disabledRun.json.status,
      },
      observedStatus: state?.json?.status,
    };
    record(
      '4_credential_revocation',
      patch.status === 200 &&
        disabledRun.status !== 202 &&
        state?.json?.status !== 'completed'
        ? '通过'
        : '失败',
      revokeRaw,
      '预期：禁用档案不能继续驱动新运行；固定 stub 模式与真实密钥撤销仍需分别验证。',
      1,
    );
  });
}
