import { Worker } from '../dist/index.js';
import { BrowserManager } from '@localqa/browser';
import { StorageError } from '@localqa/storage';
let sequence = 0;
const pending = new Map();
process.on('message', (message) => {
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  if (message.error) item.reject(new StorageError(message.error));
  else item.resolve(message.result);
});
const request = (method, args) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    process.send({ id, method, args });
  });
const runtime = Object.fromEntries(
  [
    'claim',
    'work',
    'grant',
    'record',
    'upload',
    'model',
    'finish',
    'stop',
    'heartbeat',
    'poll',
    'requireAnonymousOrInput',
  ].map((method) => [method, (...args) => request(method, args)]),
);
const manager = new BrowserManager();
const browser = {
  async createSession(options) {
    const session = await manager.createSession(options);
    return new Proxy(session, {
      get(target, key) {
        if (key === 'executeTool')
          return async (call, options) => {
            const result = await target.executeTool(call, options);
            if (call.name === 'navigate' && result.status === 'succeeded') {
              await new Promise((resolve) =>
                process.send(
                  {
                    event: 'browserActionExecuted',
                    kind: 'navigate',
                    responseStatus: result.data.responseStatus,
                    snapshotId: result.data.snapshotId,
                    pid: process.pid,
                  },
                  resolve,
                ),
              );
              process.kill(process.pid, 'SIGKILL');
            }
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  },
  close() {
    return manager.close();
  },
};
const worker = new Worker({
  runtime,
  browser,
  scratch: '/work/apps/worker/.evidence/crash-scratch',
  heartbeatMs: 10000,
  leaseSeconds: 1,
});
await worker.once();
throw new Error('Crash hook was not reached');
