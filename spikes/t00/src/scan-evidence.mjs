import { writeFile } from "node:fs/promises";
import path from "node:path";
import { scanForSentinels } from "./redact.mjs";

const evidenceDir = path.resolve(import.meta.dirname, "../evidence");
const reportPath = path.join(evidenceDir, "sentinel-scan.json");
const hits = (await scanForSentinels(evidenceDir)).filter((hit) => hit.file !== "sentinel-scan.json");
const report = {
  clean: hits.length === 0,
  hits,
  scannedAt: new Date().toISOString(),
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
const after = await scanForSentinels(evidenceDir);
if (after.length > 0) {
  console.error(JSON.stringify({ clean: false, hits: after }));
  process.exit(1);
}
console.log(JSON.stringify({ clean: true, hits: 0 }));
