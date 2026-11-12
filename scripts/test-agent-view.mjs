// Self-contained: node scripts/test-agent-view.mjs
// Spawns isolated `next dev` servers (one at a time) against a temp bd project,
// an isolated XDG_CONFIG_HOME and the stub opencode binary. PW_CHANNEL=chrome
// launches the installed Google Chrome instead of the bundled Chromium.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const stub = path.join(root, "scripts/fixtures/stub-opencode.mjs");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scotty-agent-"));
const proj = path.join(scratch, "proj");
fs.mkdirSync(proj);
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: proj, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
sh("git", ["init", "-q"]);
sh("bd", ["init", "--quiet", "--prefix", "t"]);
const created = sh("bd", ["create", "Sample bead", "-p", "2", "-t", "task", "--json"]);
const beadId = JSON.parse(created).id;
assert.ok(beadId, "bd create must yield an id");

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const children = [];
async function startScotty(name, extra = {}) {
  const port = await freePort();
  const xdg = path.join(scratch, `xdg-${name}`);
  const stubLog = path.join(scratch, `stub-${name}.log`);
  const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: root,
    env: { ...process.env, XDG_CONFIG_HOME: xdg, BEADS_REPO: proj, SCOTTY_OPENCODE_BIN: stub, STUB_LOG: stubLog, POSTHOG_KEY: "", SCOTTY_READ_ONLY: "", ...extra },
    stdio: "ignore",
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(`${base}/api/projects`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(child.exitCode, null, "next dev exited early");
  }
  const projects = await (await fetch(`${base}/api/projects`)).json();
  const list = Array.isArray(projects) ? projects : projects.projects;
  const real = list.find((p) => p.id !== "demo");
  assert.ok(real, `registered project expected: ${JSON.stringify(projects)}`);
  return { base, port, child, stubLog, projectId: real.id };
}
const stop = async (s) => {
  s.child.kill("SIGTERM");
  await new Promise((r) => { if (s.child.exitCode !== null) r(); else { s.child.once("exit", r); setTimeout(r, 5000); } });
  // the stub opencode child is owned by Scotty; stop it by the pid it logged
  try {
    for (const line of fs.readFileSync(s.stubLog, "utf8").trim().split("\n")) {
      try { process.kill(JSON.parse(line).pid, "SIGTERM"); } catch {}
    }
  } catch {}
};

const stubCreds = (s) => {
  const first = fs.readFileSync(s.stubLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.argv.includes("--port") || l.env.OPENCODE_PASSWORD).pop();
  return { password: first.env.OPENCODE_PASSWORD, argv: first.argv };
};
const stubFetch = async (s, port, p, init = {}) => {
  const { password } = stubCreds(s);
  return fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") } });
};

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
let failed = false;
try {
  // (a)(b)(c)(f): stub, editing mode
  const s = await startScotty("main");
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${s.base}/p/${s.projectId}`);

    // (a)
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    const frame = page.getByTestId("agent-frame");
    await frame.waitFor();
    const inner = page.frameLocator('[data-testid="agent-frame"]');
    await inner.getByText("stub-opencode session").waitFor();
    const srcUrl = await frame.getAttribute("src");
    const ocPort = Number(new URL(srcUrl).port);
    let log = await (await stubFetch(s, ocPort, "/__log")).json();
    assert.equal(log.filter((e) => e.path.startsWith("/auth/connect/")).length, 1, "exactly one connect per visit");

    // (c)
    const emit = (type, sessionID = "ses_stub1") =>
      stubFetch(s, ocPort, "/__emit", { method: "POST", body: `data: ${JSON.stringify({ type, data: { sessionID } })}\n\n` });
    const waitSse = async () => {
      for (let i = 0; i < 100; i++) {
        const r = await (await emit("noop.event")).json();
        if (r.clients > 0) return;
        await new Promise((r2) => setTimeout(r2, 100));
      }
      throw new Error("Scotty never subscribed to opencode events");
    };
    await waitSse();
    await emit("session.execution.started");
    await page.getByTestId("agent-working").waitFor();
    await emit("permission.asked");
    await page.getByTestId("agent-attention").waitFor();
    assert.equal((await page.getByTestId("agent-attention").textContent()).trim(), "1");
    await page.getByRole("button", { name: "Needs You" }).click();
    await page.getByText("Agent is waiting on you").waitFor();
    await emit("permission.replied");
    await emit("session.idle");
    await page.getByTestId("agent-attention").waitFor({ state: "detached" });
    await page.getByTestId("agent-working").waitFor({ state: "detached" });
    await page.getByText("Agent is waiting on you").waitFor({ state: "detached" });

    // (b)
    await page.goto(`${s.base}/p/${s.projectId}?view=board&bead=${beadId}`);
    const ask = page.getByRole("button", { name: "Ask agent" });
    await ask.waitFor();
    await ask.click();
    await page.getByTestId("agent-frame").waitFor();
    await page.frameLocator('[data-testid="agent-frame"]').getByText("stub-opencode session").waitFor();
    log = await (await stubFetch(s, ocPort, "/__log")).json();
    const put = log.find((e) => e.method === "PUT" && e.path.endsWith("/instructions/entries/scotty.context"));
    assert.ok(put, "scotty.context PUT expected");
    assert.ok(JSON.stringify(put.body).includes(beadId), "context mentions bead id");

    // bead B: a second Ask agent yields a distinct session and its own context
    const beadB = JSON.parse(sh("bd", ["create", "Second bead", "-p", "2", "-t", "task", "--json"])).id;
    assert.notEqual(beadB, beadId);
    await page.goto(`${s.base}/p/${s.projectId}?view=board&bead=${beadB}`);
    await page.getByRole("button", { name: "Ask agent" }).click();
    await page.getByTestId("agent-frame").waitFor();
    await page.frameLocator('[data-testid="agent-frame"]').getByText("stub-opencode session").waitFor();
    const puts = async () => (await (await stubFetch(s, ocPort, "/__log")).json()).filter((e) => e.method === "PUT" && e.path.endsWith("/instructions/entries/scotty.context"));
    const sessions = async () => (await (await stubFetch(s, ocPort, "/__log")).json()).filter((e) => e.method === "POST" && e.path === "/api/session");
    let p2 = await puts();
    assert.ok(p2.some((e) => JSON.stringify(e.body).includes(beadB)), "second PUT mentions bead B");
    assert.ok(p2.length >= 2, "two instruction PUTs");
    const sessionsAfterB = (await sessions()).length;
    assert.ok(sessionsAfterB >= 2, "two session POSTs");
    const putPaths = new Set(p2.map((e) => e.path));
    assert.ok(putPaths.size >= 2, "distinct sessions for A and B");

    // plain nav click: new session, no new context PUT
    const putsBefore = p2.length;
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await page.getByTestId("agent-frame").waitFor();
    await page.frameLocator('[data-testid="agent-frame"]').getByText("stub-opencode session").waitFor();
    assert.equal((await sessions()).length, sessionsAfterB + 1, "plain visit starts one new session");
    assert.equal((await puts()).length, putsBefore, "plain visit adds no instruction PUT");

    // (f)
    const r127 = await ctx.request.post(`${s.base}/api/opencode/session`, { data: { projectId: s.projectId }, headers: { origin: s.base } });
    assert.equal(r127.status(), 200);
    assert.ok((await r127.json()).connectUrl.startsWith("http://127.0.0.1:"));
    assert.deepEqual(errors, []);
  } finally {
    await stop(s);
  }

  // (d)
  const d = await startScotty("missing", { SCOTTY_OPENCODE_BIN: "/nonexistent" });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(`${d.base}/p/${d.projectId}`);
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await page.getByText("OpenCode isn't available in this install").waitFor();
  } finally {
    await stop(d);
  }

  // (e)
  const e = await startScotty("ro", { SCOTTY_READ_ONLY: "1" });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(`${e.base}/p/${e.projectId}`);
    await page.getByRole("button", { name: "Board", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Agent", exact: true }).count(), 0);
    const res = await fetch(`${e.base}/api/opencode/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: e.projectId }) });
    assert.equal(res.status, 403);
  } finally {
    await stop(e);
  }
  console.log("PASS: agent view (iframe + single connect, ask agent context, live signals, unavailable, read-only, 127.0.0.1)");
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await browser.close();
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
