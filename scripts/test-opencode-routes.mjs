// Self-contained: node scripts/test-opencode-routes.mjs
// Isolated `next dev` (stub opencode, temp XDG) for /api/opencode route guards.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const stub = path.join(root, "scripts/fixtures/stub-opencode.mjs");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scotty-routes-"));
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const children = [];
async function start(name, extra = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: root,
    env: { ...process.env, XDG_CONFIG_HOME: path.join(scratch, `xdg-${name}`), SCOTTY_OPENCODE_BIN: stub, STUB_LOG: path.join(scratch, `${name}.log`), POSTHOG_KEY: "", SCOTTY_READ_ONLY: "", ...extra },
    stdio: "ignore",
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(`${base}/api/projects`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(child.exitCode, null, "next dev exited early");
  }
  return { base, name };
}
const post = (s, body) => fetch(`${s.base}/api/opencode/session`, { method: "POST", headers: { "content-type": "application/json", origin: s.base }, body: JSON.stringify(body) });

let failed = false;
try {
  const s = await start("normal");
  let r = await post(s, { projectId: "demo" });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, "demo_project");
  r = await post(s, { projectId: "no-such-project" });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).code, "unknown_project");
  s.stop = true;
  children.pop().kill("SIGTERM");

  const ro = await start("ro", { SCOTTY_READ_ONLY: "1" });
  const ev = await fetch(`${ro.base}/api/opencode/events`);
  assert.equal(ev.status, 403);
  assert.equal((await ev.json()).code, "read_only");
  console.log("PASS: opencode routes (demo_project, unknown_project, events read-only)");
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
