import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { configDir, getConfig } from "../config.ts";
import { syncConfigDir } from "./config-sync.ts";

export class OpencodeUnavailableError extends Error {
  code: "not_installed" | "start_failed";
  constructor(code: "not_installed" | "start_failed", message: string) {
    super(message);
    this.name = "OpencodeUnavailableError";
    this.code = code;
  }
}

export type ServerHandle = { url: string; port: number; password: string; pid: number };

const DEFAULT_START_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2000;
function startTimeoutMs(): number {
  const n = Number(process.env.SCOTTY_OPENCODE_START_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_START_TIMEOUT_MS;
}
const POLL_MS = 200;

function pkgJsonPath(): string | null {
  try {
    return createRequire(path.join(process.cwd(), "noop.js")).resolve("@opencode/cli/package.json");
  } catch {
    try {
      return createRequire(import.meta.url).resolve("@opencode/cli/package.json");
    } catch {
      return null;
    }
  }
}

function readPkg(): { version?: string; bin?: Record<string, string> | string } | null {
  const p = pkgJsonPath();
  if (!p) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function resolveOpencodeBin(): string | null {
  if (process.env.SCOTTY_OPENCODE_BIN) return process.env.SCOTTY_OPENCODE_BIN;
  const p = pkgJsonPath();
  const pkg = readPkg();
  if (!p || !pkg?.bin) return null;
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.opencode;
  if (!rel) return null;
  const bin = path.resolve(path.dirname(p), rel);
  return fs.existsSync(bin) ? bin : null;
}

export function pinnedVersion(): string | null {
  return readPkg()?.version ?? null;
}

export function opencodeEnv(
  appDir: string,
  password: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_CONTENT;
  delete env.OPENCODE_DB;
  return {
    ...env,
    // App-owned empty dir so opencode never falls back to the real ~/.config/opencode.
    XDG_CONFIG_HOME: path.join(appDir, "xdg-config"),
    XDG_DATA_HOME: path.join(appDir, "data"),
    XDG_STATE_HOME: path.join(appDir, "state"),
    XDG_CACHE_HOME: path.join(appDir, "cache"),
    OPENCODE_CONFIG_DIR: path.join(appDir, "config"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_PASSWORD: password,
  };
}

function appDir(): string {
  return path.join(configDir(), "opencode");
}
function stateFile(): string {
  return path.join(appDir(), "server.json");
}

function assetsDir(): string {
  if (process.env.SCOTTY_ASSETS_DIR) return process.env.SCOTTY_ASSETS_DIR;
  const cwdDir = path.join(process.cwd(), "opencode-assets");
  if (fs.existsSync(cwdDir)) return cwdDir;
  try {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "opencode-assets");
  } catch {
    return cwdDir;
  }
}

function userDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "opencode");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fetchInfo(port: number, password: string): Promise<{ version?: string; pid?: number } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/info`, {
      headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { version?: string; pid?: number };
  } catch {
    return null;
  }
}

function readState(): { pid: number; port: number; password: string } | null {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (Number.isInteger(s.pid) && Number.isInteger(s.port) && typeof s.password === "string") return s;
  } catch {
    // missing or corrupt
  }
  return null;
}

function toHandle(s: { pid: number; port: number; password: string }): ServerHandle {
  return { url: `http://127.0.0.1:${s.port}`, port: s.port, password: s.password, pid: s.pid };
}

async function reuse(): Promise<ServerHandle | null> {
  const s = readState();
  if (!s || !isAlive(s.pid)) return null;
  const info = await fetchInfo(s.port, s.password);
  if (!info || info.version !== pinnedVersion()) return null;
  return toHandle(s);
}

// SCOTTY_OPENCODE_PORT / SCOTTY_OPENCODE_HOST let a container publish the agent
// server: the browser's iframe needs a fixed port, and a published port only
// reaches a listener bound to the container's interface (0.0.0.0, with the host
// side of the mapping limited to 127.0.0.1). Defaults stay random + loopback.
export function listenConfig(env: NodeJS.ProcessEnv = process.env): { host: string; port: number | null } {
  const raw = Number(env.SCOTTY_OPENCODE_PORT);
  const port = Number.isInteger(raw) && raw >= 1 && raw <= 65535 ? raw : null;
  const host = env.SCOTTY_OPENCODE_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
  return { host, port };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

// Held on globalThis so duplicated module instances (Next bundling/HMR) share
// one child, one in-flight start and one set of process listeners.
type State = {
  child: ChildProcess | null;
  starting: Promise<ServerHandle> | null;
  hooksRegistered: boolean;
};
const STATE_KEY = Symbol.for("scotty.opencode.server");
const g = globalThis as unknown as Record<symbol, State | undefined>;
const state: State = (g[STATE_KEY] ??= { child: null, starting: null, hooksRegistered: false });

// Signals: stop our child, then re-raise default behaviour only if we were the
// sole listener. If Next (or anything else) also listens, it keeps control of
// shutdown and we must not swallow or pre-empt it.
function registerHooks() {
  if (state.hooksRegistered) return;
  state.hooksRegistered = true;
  process.on("exit", stopServer);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      stopServer();
      if (process.listenerCount(sig) === 1) {
        process.removeListener(sig, handler);
        process.kill(process.pid, sig);
      }
    };
    process.on(sig, handler);
  }
}

async function spawnServer(): Promise<ServerHandle> {
  const bin = resolveOpencodeBin();
  if (!bin || !fs.existsSync(bin)) {
    throw new OpencodeUnavailableError("not_installed", "opencode binary not found");
  }
  const dir = appDir();
  fs.mkdirSync(path.join(dir, "xdg-config"), { recursive: true });
  const importUser = getConfig().importOpencodeConfig ?? true;
  syncConfigDir({ userDir: userDir(), targetDir: path.join(dir, "config"), assetsDir: assetsDir(), importUser });

  const listen = listenConfig();
  const port = listen.port ?? (await freePort());
  const password = crypto.randomBytes(24).toString("hex");
  let proc: ChildProcess;
  try {
    proc = spawn(bin, ["serve", "--hostname", listen.host, "--port", String(port)], {
      stdio: "ignore",
      env: opencodeEnv(dir, password),
    });
  } catch (err) {
    throw new OpencodeUnavailableError("start_failed", `failed to spawn opencode: ${(err as Error).message}`);
  }
  let exited: string | null = null;
  proc.once("error", (err) => { exited = err.message; });
  proc.once("exit", (code, sig) => {
    exited = `exited (${code ?? sig})`;
    if (state.child === proc) state.child = null;
  });
  state.child = proc;
  registerHooks();

  const deadline = Date.now() + startTimeoutMs();
  while (Date.now() < deadline) {
    if (exited) break;
    const info = await fetchInfo(port, password);
    if (info && proc.pid) {
      const state = { pid: proc.pid, port, password };
      fs.writeFileSync(stateFile(), JSON.stringify(state), { mode: 0o600 });
      fs.chmodSync(stateFile(), 0o600);
      return toHandle(state);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const reason = exited ?? "timed out waiting for server";
  if (state.child === proc) stopServer();
  throw new OpencodeUnavailableError("start_failed", `opencode failed to start: ${reason}`);
}

export async function ensureServer(): Promise<ServerHandle> {
  if (state.starting) return state.starting;
  const p = (async () => (await reuse()) ?? (await spawnServer()))();
  state.starting = p;
  try {
    return await p;
  } finally {
    if (state.starting === p) state.starting = null;
  }
}

export async function peekServer(): Promise<ServerHandle | null> {
  return reuse();
}

export function stopServer(): void {
  const proc = state.child;
  state.child = null;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    return;
  }
  const t = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }, KILL_GRACE_MS);
  t.unref();
}
