import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BrowserManager } from '@localqa/browser';

// 66 only. Six parallel tasks, each with an isolated context and only one
// browser mutation per session. No safety-loop override or fake results.
const CLIENTS = 6,
  ROUNDS = 18;
const manager = new BrowserManager();
const begin = performance.now(),
  durations = [],
  errors = [],
  rss = [];
let succeeded = 0,
  screenshots = 0;
const percentile = (q) => {
  const sorted = [...durations].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(q * (sorted.length - 1))]);
};
try {
  await Promise.all(
    Array.from({ length: CLIENTS }, async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const start = performance.now();
        const session = await manager.createSession({
          projectId: randomUUID(),
          runId: randomUUID(),
          taskId: randomUUID(),
          mode: 'full',
        });
        try {
          const page = session.getPage();
          await page.setContent(
            '<button data-testid="clickonce">Proceed</button><output id="result">pending</output><script>document.querySelector("button").onclick=()=>document.querySelector("#result").textContent="done"</script>',
          );
          const snapshot = await session.getSnapshot({ forceFresh: true });
          const result = await session.executeTool({
            name: 'click',
            args: {
              target: {
                pageId: snapshot.pageId,
                snapshotId: snapshot.snapshotId,
                nodeId: 'testid_clickonce',
              },
            },
          });
          assert.equal(
            result.status,
            'succeeded',
            result.reasonCode ?? 'unknown',
          );
          assert.equal(await page.locator('#result').textContent(), 'done');
          if (round % 3 === 0) {
            const image = await page.screenshot({ type: 'jpeg', quality: 60 });
            assert.ok(image.length > 200);
            screenshots++;
          }
          succeeded++;
          durations.push(performance.now() - start);
        } catch (error) {
          errors.push(String(error.message).slice(0, 160));
        } finally {
          await session.close();
        }
        if (round % 3 === 0) rss.push(process.memoryUsage().rss);
      }
    }),
  );
  const stats = {
    clients: CLIENTS,
    sessionsAttempted: CLIENTS * ROUNDS,
    succeeded,
    failures: errors.length,
    screenshotSamples: screenshots,
    elapsedMs: Math.round(performance.now() - begin),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    nodeRssFirstMB: Math.round(rss[0] / 1048576),
    nodeRssLastMB: Math.round(rss.at(-1) / 1048576),
    nodeRssPeakMB: Math.round(Math.max(...rss) / 1048576),
  };
  console.log('T50_CHROMIUM_CONCURRENCY', JSON.stringify(stats));
  if (errors.length)
    console.log('T50_ERRORS', JSON.stringify(errors.slice(0, 5)));
  assert.equal(errors.length, 0);
  assert.equal(succeeded, CLIENTS * ROUNDS);
} finally {
  await manager.close();
  console.log('T50_BROWSER_MANAGER_CLOSED');
}
