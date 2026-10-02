import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const SENTINELS = {
  hiddenInput: "LQA_HIDDEN_INPUT_SECRET",
  password: "LQA_PASSWORD_SECRET",
  cookie: "LQA_COOKIE_SECRET",
  storage: "LQA_STORAGE_SECRET",
  session: "LQA_SESSION_SECRET",
  query: "LQA_QUERY_SECRET",
  console: "LQA_CONSOLE_SENTINEL",
};

const SECRETS = Object.values(SENTINELS);
const SENSITIVE_KEY = /auth|token|key|secret|password|session/i;

export function redactText(input) {
  let out = String(input);
  for (const secret of SECRETS) out = out.split(secret).join("[redacted]");
  return out.replace(/([?&#](?:auth|token|key|secret|password|session)=)[^&#\s"']+/gi, "$1[redacted]");
}

export function redactUrl(raw) {
  try {
    const url = new URL(raw);
    const parts = [];
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_KEY.test(key)) parts.push(`${encodeURIComponent(key)}=[redacted]`);
      else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(url.searchParams.get(key) ?? "")}`);
    }
    const hash = url.hash ? `#${redactText(url.hash.slice(1))}` : "";
    return `${url.origin}${url.pathname}${parts.length ? `?${parts.join("&")}` : ""}${hash}`;
  } catch {
    return redactText(raw);
  }
}

export function deepRedact(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(deepRedact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = deepRedact(item);
    return out;
  }
  return value;
}

export function containedKinds(text) {
  return Object.entries(SENTINELS).filter(([, secret]) => text.includes(secret)).map(([kind]) => kind);
}

export async function scanForSentinels(dir) {
  const hits = [];
  async function walk(current) {
    let names;
    try {
      names = await readdir(current);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(current, name);
      const info = await stat(full);
      if (info.isDirectory()) {
        await walk(full);
        continue;
      }
      const buf = await readFile(full);
      for (const [kind, secret] of Object.entries(SENTINELS)) {
        if (buf.includes(secret)) hits.push({ file: path.relative(dir, full), kind });
      }
    }
  }
  await walk(dir);
  return hits;
}
