// Runs every test/*.test.mjs against a fresh broker process (own port, own empty data dir).
// Usage: npm run build && npm test
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.mjs")).sort();
const only = process.argv[2];
let pass = 0, fail = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts) => new Promise((resolve) => {
  const p = spawn(cmd, args, opts);
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  p.on("close", (code) => resolve({ code, out }));
});

for (const [i, f] of files.entries()) {
  if (only && !f.includes(only)) continue;
  const port = 8100 + i;
  const data = mkdtempSync(join(tmpdir(), "broker-test-"));
  const env = {
    ...process.env, PORT: String(port), DATA_DIR: data, SECRET_KEY: "test-secret-key-0123456789",
    ADMIN_EMAIL: "admin@x.io", ADMIN_PASSWORD: "adminpass1", WEBHOOK_ALLOW_PRIVATE: "1", BASE_URL: `http://127.0.0.1:${port}`,
  };
  const server = spawn("node", ["dist/index.js"], { cwd: root, env, stdio: "ignore" });
  let up = false;
  for (let t = 0; t < 50 && !up; t++) {
    await sleep(200);
    try { up = (await fetch(`${env.BASE_URL}/healthz`)).ok; } catch {}
  }
  if (!up) { console.log(`FAIL ${f}: server did not start`); fail++; server.kill(); continue; }

  const { out } = await run("node", [join("test", f)], { cwd: root, env });
  server.kill();
  rmSync(data, { recursive: true, force: true });
  const lines = out.split("\n").filter((l) => /^(PASS|FAIL) /.test(l));
  const p = lines.filter((l) => l.startsWith("PASS")).length;
  const x = lines.filter((l) => l.startsWith("FAIL")).length;
  const crashed = !lines.length;
  console.log(`${x || crashed ? "✗" : "✓"} ${f}: ${p} passed, ${x} failed${crashed ? " (no results — script crashed)" : ""}`);
  for (const l of lines.filter((l) => l.startsWith("FAIL"))) console.log("    " + l.slice(0, 300));
  if (crashed) console.log(out.split("\n").slice(-8).map((l) => "    " + l).join("\n"));
  pass += p; fail += x + (crashed ? 1 : 0);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
