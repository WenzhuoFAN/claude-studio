// Smoke test: calls both agents directly (no MCP) with a trivial task in a temp dir.
// Usage: npm run selftest [-- codex|deepseek]
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { delegateToCodex, delegateToDeepseek, formatResult } from "./agents.js";

const which = process.argv[2];
const dir = mkdtempSync(path.join(os.tmpdir(), "mao-selftest-"));
try {
  if (!which || which === "codex") {
    const r = await delegateToCodex({ task: "Create a file codex.txt containing exactly: ok. Then reply DONE.", cwd: dir, mode: "workspace-write", timeoutSec: 300 });
    console.log(formatResult(r) + "\n");
  }
  if (!which || which === "deepseek") {
    const r = await delegateToDeepseek({ task: "Create a file deepseek.txt containing exactly: ok. Then reply DONE.", cwd: dir, timeoutSec: 300 });
    console.log(formatResult(r) + "\n");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
