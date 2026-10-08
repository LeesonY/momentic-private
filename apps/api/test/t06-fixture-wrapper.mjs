// Local HTTP fixture only: no browser, worker or model provider is started.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const app = require('../../../packages/test-fixture/server.js');
const server = app.listen(0, '127.0.0.1', () => {
  process.send?.({ port: server.address().port, pid: process.pid });
});
function stop() {
  server.close(() => process.exit(0));
  server.closeAllConnections();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('disconnect', stop);
