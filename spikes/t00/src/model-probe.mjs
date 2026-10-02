import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const templatePath = path.join(root, "templates/model-compat.template.json");
const evidenceDir = path.join(root, "evidence");

const envNames = ["LOCALQA_MODEL_BASE_URL", "LOCALQA_MODEL_API_KEY", "LOCALQA_MODEL_ID"];
const envPresent = Object.fromEntries(envNames.map((name) => [name, Boolean(process.env[name])]));
const template = JSON.parse(await readFile(templatePath, "utf8"));

const result = {
  ...template,
  status: "blocked",
  executedAt: new Date().toISOString(),
  networkCallMade: false,
  enableFlag: process.env.LOCALQA_MODEL_PROBE_ENABLE === "1",
  envPresent,
  blockedReason: "T00 macOS spike 不调用模型 API。本脚本没有请求实现。待用户提供 HTTPS endpoint、model id 与密钥，并明确允许调用后再做能力探测。",
  checks: template.checks.map((check) => ({ ...check, status: "blocked", result: null })),
};

await mkdir(evidenceDir, { recursive: true });
await writeFile(path.join(evidenceDir, "model-probe-result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  status: "blocked",
  networkCallMade: false,
  enableFlag: result.enableFlag,
  envPresent,
}));
