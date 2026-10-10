// Real external provider, disposable PostgreSQL18 and Chromium, human-approved
// regression, localhost-only DOM form interaction.
// A one-off credential may be piped via stdin as JSON; it stays in memory,
// is not written to the worktree or inherited by child processes.
import { readFileSync } from 'node:fs';
process.env.LOCALQA_T17_REAL_INTERACTIVE = '1';
if (process.argv.includes('broken')) process.env.LOCALQA_T17_BROKEN = '1';
if (process.argv.includes('deepseek'))
  process.env.LOCALQA_T17_PI_DEEPSEEK = '1';
if (!process.stdin.isTTY) {
  const incoming = readFileSync(0, 'utf8').trim();
  if (incoming) {
    const parsed = JSON.parse(incoming);
    const endpoint = new URL(parsed.endpoint);
    if (
      endpoint.protocol !== 'https:' ||
      !['api.deepseek.com', 'motoken.moresec.cn'].includes(endpoint.hostname) ||
      typeof parsed.apiKey !== 'string' ||
      !parsed.apiKey.startsWith('sk-') ||
      !['openai_compatible', 'anthropic_messages'].includes(parsed.adapter) ||
      typeof parsed.model !== 'string' ||
      parsed.model.length < 2
    )
      throw Error('INVALID_EPHEMERAL_MODEL_CONFIGURATION');
    Object.defineProperty(globalThis, '__localqaT17Model', {
      value: { endpoint: endpoint.href.replace(/\/$/, ''), ...parsed },
      configurable: true,
    });
  }
}
await import('../apps/worker/test/t14-provider-wire-pg-chromium.integration.mjs');
