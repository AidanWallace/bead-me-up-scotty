# OpenCode Session in Scotty — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed a live OpenCode agent session in Scotty's web UI, running on a Scotty-owned, version-pinned, isolated OpenCode instance, and route "Refine with AI" through it with Claude as fallback.

**Architecture:** Scotty spawns its own `opencode serve` (127.0.0.1, random port/password, private XDG data/state/cache + private `OPENCODE_CONFIG_DIR`) and iframes its web UI. A thin adapter module is the only code that knows OpenCode's experimental HTTP API. Config is rebuilt on each server start by one-way copying the user's agents/skills/providers plus Scotty's own `scotty` agent and `scotty-ui` skill.

**Tech Stack:** Next.js 16 (App Router, route handlers, `proxy.ts`), React 19, TanStack Query, `@opencode/cli@2.2.7` (exact pin), Node stdlib only for process management, Playwright for UI tests, `.mjs` tests that import `.ts` directly (see `scripts/test-actor-default.mjs`, run server-only modules with `node --conditions=react-server`).

**Spec:** `docs/superpowers/specs/2026-11-12-opencode-session-design.md`

## Global Constraints

- **Do not commit, stage, stash, or push anything.** Work on branch `feat/opencode-integration` (already created from `5b6f4c0`). Where a task would normally end in a commit, it ends in a *Checkpoint* (`git status --short` lists only the files the task names).
- `@opencode/cli` is an **exact** version in `package.json` (`"2.2.7"`, no `^`/`~`). `OPENCODE_DISABLE_AUTOUPDATE=1` always set.
- Never write to, symlink into, or delete anything under `~/.config/opencode` or `~/.local/share/opencode`. One-way **copies** only. Never copy `auth.json`. Never import the user's `plugins` or `mcp`.
- Server binds `--hostname 127.0.0.1` only; password is random per install and never put in a URL the browser sees (only single-use pairing codes are).
- Iframe URL host = the hostname of the request's `Host` header (same-site cookie rule; `localhost` ≠ `127.0.0.1`).
- OpenCode v2 only; API is experimental → every endpoint shape lives in `lib/opencode/client.ts`.
- This Next.js has breaking changes: read the relevant guide in `node_modules/next/dist/docs/` before writing route handlers or touching `proxy.ts`.
- New pure modules must not import `server-only` (so they are testable); process/network modules do import it.
- Track work with `bd` (not markdown TODOs); beads data stays local-only (AGENTS.md).

## Review Focus

1. User's `opencode.jsonc` contains `https://…` inside strings, `//` comments, `/* */` comments and trailing commas → config generation must not corrupt or throw (Task 2).
2. OpenCode binary missing/unresolvable, or `~/.config/opencode` absent/invalid → Agent view shows a clear "unavailable" state, Refine with AI silently uses Claude (Tasks 3, 5, 7).
3. Scotty opened as `127.0.0.1`, `localhost`, a `SCOTTY_ALLOWED_HOSTS` LAN name, or an IPv6 literal → iframe URL uses that exact host (bracketed for IPv6) (Task 6).
4. Scotty restarted/crashed while the OpenCode child is still alive → reuse it (or replace it), never leak a second server or a stale password (Task 3).
5. Viewer/read-only mode → Agent nav hidden, `/api/opencode/*` writes return 403 (Tasks 6, 7).

---

### Task 1: Pin the CLI, ship Scotty's agent and skill

**Files:**
- Modify: `package.json` (dependency + `files`), `package-lock.json` (via npm)
- Create: `opencode-assets/agents/scotty.md`, `opencode-assets/skills/scotty-ui/SKILL.md`
- Test: `scripts/test-opencode-assets.mjs`

**Interfaces:**
- Produces: directory `opencode-assets/` (shipped in the npm package) consumed by Task 2 as `assetsDir`.

- [ ] **Step 1: Write the failing test** `scripts/test-opencode-assets.mjs` (plain `node:assert`): read `package.json`; assert `dependencies["@opencode/cli"]` matches `/^\d+\.\d+\.\d+$/`; assert `files` includes `"opencode-assets"`; assert `opencode-assets/agents/scotty.md` frontmatter contains `mode: primary` and a `shell` rule `resource: "bd *"` with `effect: allow` and a catch-all `shell` `effect: ask`; assert `opencode-assets/skills/scotty-ui/SKILL.md` frontmatter has non-empty `description`.
- [ ] **Step 2: Run** `node scripts/test-opencode-assets.mjs` → FAIL (missing dependency/files).
- [ ] **Step 3: Run** `npm install --save-exact @opencode/cli@2.2.7`; add `"opencode-assets"` to `files`.
- [ ] **Step 4: Write the two asset files.** Agent: `description: Scotty's bead assistant`, `mode: primary`, permissions: `shell *` ask, `shell bd *` allow, `shell git push *` deny; body tells the agent it runs inside the Scotty board, must use `bd` for all task changes, refer to beads by id, and not edit files unless asked. Skill (`name: Scotty UI`, description "Use when working inside the Scotty board UI"): short rules mirroring the body (read the existing `.agents/skills/beads/SKILL.md` for tone).
- [ ] **Step 5: Run** the test → PASS. Also run `npx opencode --version` from the repo → prints `opencode v2.2.7`.
- [ ] **Step 6: Checkpoint** — `git status --short` shows only the files above (plus the untracked spec/plan docs).

### Task 2: Config sync (one-way copy)

**Files:**
- Create: `lib/opencode/config-sync.ts` (no `server-only`)
- Test: `scripts/test-opencode-config-sync.mjs`

**Interfaces:**
- Produces:
  - `stripJsonc(text: string): string` — removes `//` and `/* */` comments and trailing commas **outside strings**.
  - `buildConfig(userConfigText: string | null, opts: { importProviders: boolean }): Record<string, unknown>` → always `{ $schema: "https://opencode.ai/config.json", default_agent: "scotty", update: "disable" }`, plus `providers` copied from the user's config when `importProviders` and parseable. Never includes `plugins`, `mcp`, or anything else.
  - `syncConfigDir(opts: { userDir: string; targetDir: string; assetsDir: string; importUser: boolean }): void`.

- [ ] **Step 1: Write failing tests** (temp dirs via `fs.mkdtempSync`): (a) `stripJsonc` keeps `"$schema": "https://opencode.ai/config.json"` intact and strips `// c`, `/* c */`, and `,}` / `,]`; (b) `buildConfig` with the user's real-shaped JSONC (providers + plugins + mcp + comments) returns `providers` only, no `plugins`/`mcp`; with `null`, malformed text, or `importProviders:false` returns the base keys without throwing; (c) `syncConfigDir`: user dir with `agents/a.md`, `agents/scotty.md` (user's own), `skills/s/SKILL.md`, `node_modules/x`, `.DS_Store`, `service.json`, `opencode.jsonc` → target has `agents/a.md`, `skills/s/SKILL.md`, Scotty's `agents/scotty.md` (asset wins over the user's), `skills/scotty-ui/SKILL.md`, generated `opencode.jsonc`; no `node_modules`, `.DS_Store`, `service.json`; **user dir byte-identical before/after** (hash every file + assert no new files); stale files from a previous sync are removed from target's `agents/`, `skills/`, `opencode.jsonc` but other target content (e.g. `node_modules/`, plugin cache) is left alone; `importUser:false` → only Scotty assets; missing `userDir` → no throw.
- [ ] **Step 2: Run** `node scripts/test-opencode-config-sync.mjs` → FAIL.
- [ ] **Step 3: Implement** the three functions. `stripJsonc` is a small state machine (in-string / escape / line-comment / block-comment), not a regex. Use `fs.cpSync` with a filter for copies.
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Checkpoint.**

### Task 3: Server lifecycle

**Files:**
- Modify: `lib/config.ts` (export `configDir()`)
- Create: `lib/opencode/server.ts` (`import "server-only"`), `scripts/fixtures/stub-opencode.mjs`
- Test: `scripts/test-opencode-server.mjs` (run with `node --conditions=react-server`)

**Interfaces:**
- Consumes: `syncConfigDir`, `buildConfig` from Task 2; `configDir()` from `lib/config.ts`.
- Produces:
  - `class OpencodeUnavailableError extends Error { code: "not_installed" | "start_failed" }`.
  - `resolveOpencodeBin(): string | null` — `SCOTTY_OPENCODE_BIN` env, else the `bin.opencode` of `@opencode/cli` resolved via `createRequire(import.meta.url).resolve("@opencode/cli/package.json")`, else `null`.
  - `opencodeEnv(appDir: string, password: string, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv` (pure): sets `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` to `<appDir>/{data,state,cache}`, `OPENCODE_CONFIG_DIR=<appDir>/config`, `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_PASSWORD=<password>`.
  - `type ServerHandle = { url: string; port: number; password: string; pid: number }`.
  - `ensureServer(): Promise<ServerHandle>`, `peekServer(): Promise<ServerHandle | null>` (never starts), `stopServer(): void`.
- App dir = `<configDir()>/opencode`. State file `<appDir>/server.json` (mode 0600) holds `{pid, port, password}`.

- [ ] **Step 1: Write the stub** `scripts/fixtures/stub-opencode.mjs` (`#!/usr/bin/env node`, executable): parses `--hostname/--port`, serves Basic-auth `opencode:$OPENCODE_PASSWORD`: `GET /api/info` → `{version:"2.2.7",pid:process.pid}` (401 without auth), appends `{argv, env subset}` to `$STUB_LOG` when set. (Later tasks extend it: Task 7.)
- [ ] **Step 2: Write failing tests:** with `SCOTTY_OPENCODE_BIN` = stub and `XDG_CONFIG_HOME` = temp: `ensureServer()` returns a handle whose `/api/info` answers with the password; stub log shows `--hostname 127.0.0.1`, the four isolation env vars + `OPENCODE_DISABLE_AUTOUPDATE=1`; the generated `<appDir>/config/opencode.jsonc` exists; calling `ensureServer()` twice returns the same pid; killing the child then calling again returns a *new* pid; **a second Node process** with the same `XDG_CONFIG_HOME` reuses the live server (same pid) instead of spawning; a stale `server.json` (dead pid) is ignored; `stopServer()` ends the process; with `SCOTTY_OPENCODE_BIN=/nonexistent` → rejects with `OpencodeUnavailableError` code `not_installed`; stub that exits immediately → `start_failed` within the timeout; `opencodeEnv()` never inherits the caller's `OPENCODE_CONFIG_DIR`/`XDG_*`.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement** `server.ts`. Free port via `net.createServer().listen(0)`; spawn `{stdio:"ignore"}` with `opencodeEnv`; wait for `/api/info` (poll 200 ms, 30 s timeout); register `process.on("exit", stopServer)`; reuse path: read `server.json`, `process.kill(pid,0)`, then authenticated `/api/info` must return `version === "2.2.7"` (read the pinned version from `@opencode/cli/package.json`). Call `syncConfigDir` before every spawn only (read `importOpencodeConfig` from `getConfig()` as `(getConfig() as { importOpencodeConfig?: boolean }).importOpencodeConfig ?? true` — Task 5 adds the typed field; default true; userDir = `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`; assetsDir = `<process.cwd()>/opencode-assets`, overridable by `SCOTTY_ASSETS_DIR` for tests).
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Checkpoint.**

### Task 4: API adapter and event signals

**Files:**
- Create: `lib/opencode/client.ts` (`server-only`), `lib/opencode/signals.ts` (pure)
- Test: `scripts/test-opencode-client.mjs` (`--conditions=react-server`, uses the stub), `scripts/test-opencode-signals.mjs`

**Interfaces:**
- Consumes: `ServerHandle` (Task 3).
- Produces (client.ts, all take `h: ServerHandle`):
  - `pair(h): Promise<string>` — `POST /api/pair` body `{}` → `code`.
  - `createSession(h, directory: string): Promise<string>` — `POST /api/session` body `{location:{directory}}` → `data.id`.
  - `generateText(h, prompt: string, directory: string): Promise<string>` — `POST /api/experimental/generate/text?location[directory]=…` body `{prompt}` → `data.text`.
  - `putInstruction(h, sessionId: string, key: string, value: string): Promise<void>` — `PUT /api/experimental/session/{id}/instructions/entries/{key}` body `{value}`.
  - `subscribeEvents(h, signal: AbortSignal): AsyncIterable<unknown>` — `GET /api/event` SSE (`data:` lines → JSON).
  - `class OpencodeApiError extends Error { status: number }` for non-2xx.
- Produces (signals.ts): `type AgentSignal = { kind: "working" | "idle" | "attention" | "attention-cleared" | "tool-finished"; sessionId: string }` and `mapEvent(ev: unknown): AgentSignal | null`.
  - Mapping: `session.execution.started` → working; `session.execution.succeeded|failed|interrupted` and `session.idle` → idle; `permission.asked` and `form.created` → attention; `permission.replied`, `form.replied`, `form.cancelled` → attention-cleared; `session.tool.success` → tool-finished; anything else → `null`. `sessionId = data.sessionID ?? durable.aggregateID ?? ""`; malformed input → `null`, never throws.

- [ ] **Step 1: Write failing tests:** signals — one fixture per mapping row plus unknown type, `null`, a string, missing `data`; client — against the stub: each function sends the documented method/path/body with the `Authorization: Basic base64("opencode:"+password)` header, parses the response shape, a 401/500 throws `OpencodeApiError` with `status`, `subscribeEvents` yields two JSON events split across chunk boundaries and ends on abort.
- [ ] **Step 2: Extend the stub** with the matching routes (`/api/pair`, `/api/session`, `/api/experimental/generate/text` returning `{data:{text:"pong"}}`, the PUT, `/api/event` that emits whatever `POST /__emit` receives). Run → FAIL, then implement → PASS.
- [ ] **Step 3: Checkpoint.**

### Task 5: Provider split and settings

**Files:**
- Create: `lib/ai-provider.ts` (pure)
- Modify: `lib/ai.ts`, `lib/config.ts` (`aiProvider`, `importOpencodeConfig`), `app/api/config/route.ts` (schema), `lib/api-client.ts` (types), `components/settings-view.tsx`, `app/api/p/[projectId]/beads/[id]/assist/route.ts`
- Test: `scripts/test-ai-provider.mjs` (`--conditions=react-server`)

**Interfaces:**
- Produces:
  - `type AiProvider = "opencode" | "claude"`; `AppConfig.aiProvider?: "auto" | AiProvider` (default `"auto"`); `AppConfig.importOpencodeConfig?: boolean` (default `true`).
  - `resolveProvider(pref: "auto" | AiProvider | undefined, avail: { opencode: boolean; claude: boolean }): AiProvider | null` — `auto` prefers opencode; an explicit choice that is unavailable falls to the other; none → `null`.
  - `assistBead(input: AssistInput, ctx: { directory: string | null; pref?: "auto" | AiProvider }, deps?: { runOpencode?: (prompt: string, dir: string | null) => Promise<string>; runClaude?: (prompt: string) => Promise<string>; avail?: () => Promise<{opencode: boolean; claude: boolean}> }): Promise<AssistResult>` (same result type as today).
  - Real OpenCode runner: `ensureServer()` + `generateText(h, prompt, directory ?? process.cwd())`.
- Behavior: if the chosen runner throws `AiError`/`OpencodeUnavailableError` with code `not_installed`/`start_failed`/`claude_unavailable` and the other provider is available, use the other; `bad_output` and `timeout` do **not** fall back. JSON prompt/parse/`validIds` filtering unchanged.

- [ ] **Step 1: Write failing tests:** `resolveProvider` table (auto+both→opencode, auto+claude only→claude, explicit claude+both→claude, explicit opencode unavailable→claude, none→null); `assistBead` with fakes: opencode fake returning JSON → parsed result, claude not called; opencode fake throwing `not_installed` → claude fake used; opencode returning prose → `AiError` `bad_output` and claude **not** called; neither available → `AiError`; config defaults: with temp `XDG_CONFIG_HOME`, `getConfig().aiProvider === "auto"`, `saveConfig({aiProvider:"claude", importOpencodeConfig:false})` round-trips.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Keep `AiError` and `isClaudeAvailable` exports; the route passes the project's path (null for demo) and `getConfig().aiProvider`.
- [ ] **Step 4: Settings UI:** next to the gamification toggle pattern in `components/settings-view.tsx`, add a "AI provider" select (Auto / OpenCode / Claude) and an "Import my OpenCode agents, skills and providers" checkbox; both persist via `api.saveConfig`. Update `components/ai-assist-panel.tsx` copy from "local Claude CLI" to "AI provider".
- [ ] **Step 5: Run** the test → PASS; `npm run lint`.
- [ ] **Step 6: Checkpoint.**

### Task 6: Agent API routes

**Files:**
- Create: `app/api/opencode/status/route.ts`, `app/api/opencode/session/route.ts`, `app/api/opencode/events/route.ts`, `lib/opencode/urls.ts` (pure)
- Test: `scripts/test-opencode-urls.mjs`; route behavior is covered by Task 7's Playwright test

**Interfaces:**
- Consumes: Tasks 3–4.
- Produces (urls.ts): `iframeHost(hostHeader: string | null): string` (hostname without port; IPv6 bracketed; `null`/empty → `"localhost"`); `connectUrl(host: string, port: number, code: string): string` → `http://<host>:<port>/auth/connect/<code>`; `sessionUrl(host: string, port: number, sessionId: string): string` → `http://<host>:<port>/server/<base64url("http://127.0.0.1:"+port)>/session/<sessionId>` (base64url, no padding; the base64 target is the server URL the UI itself uses — verify against what the UI generates in Task 8's manual run and adjust here if it uses `host` instead of `127.0.0.1`).
- Routes:
  - `GET /api/opencode/status` → `{available: boolean, running: boolean, version: string | null, pinned: string}`; never starts the server; `available = resolveOpencodeBin() !== null`.
  - `POST /api/opencode/session` body zod `{projectId: string, beadId?: string}` → `{sessionId, connectUrl, sessionUrl}`. 403 `{code:"read_only"}` when `isReadOnly(req)`; 400 for the demo project (`path` null); 404 unknown project; 503 `{code:"not_installed"|"start_failed"}` on `OpencodeUnavailableError`. With `beadId`, call `putInstruction(h, id, "scotty.context", "<one paragraph: the user is looking at bead {id} “{title}”; use bd to read/update it>")` (title from the project's store).
  - `GET /api/opencode/events` → `text/event-stream` of `AgentSignal` JSON (`data: {...}\n\n`); keepalive comment every 15 s; if the server is not running, poll `peekServer()` every 1 s and attach when it appears; abort upstream on client disconnect. 403 when read-only.

- [ ] **Step 1: Write failing tests** for `iframeHost` (`"localhost:3000"`→`localhost`, `"127.0.0.1:3197"`→`127.0.0.1`, `"[::1]:3000"`→`[::1]`, `"mybox.local"`→`mybox.local`, `null`→`localhost`) and both URL builders (exact strings, base64url without `=`).
- [ ] **Step 2: Run** → FAIL → implement → PASS.
- [ ] **Step 3: Write the three route handlers** following `app/api/p/[projectId]/beads/[id]/assist/route.ts` (`ok`/`fail` helpers from `lib/api.ts`, `export const dynamic = "force-dynamic"`). `proxy.ts` needs no change (these are not under `/api/p/`, so the routes do their own `isReadOnly` check).
- [ ] **Step 4: Run** `npm run lint` and `npx tsc --noEmit`.
- [ ] **Step 5: Checkpoint.**

### Task 7: Agent view, entry points, live signals

**Files:**
- Modify: `lib/views.ts`, `components/app-context.tsx`, `components/app-shell.tsx`, `components/sidebar.tsx`, `components/command-palette.tsx`, `components/bead-detail-drawer.tsx`, `components/needs-you-view.tsx`, `lib/api-client.ts`, `scripts/fixtures/stub-opencode.mjs`
- Create: `components/agent-view.tsx`, `hooks/use-agent-signals.ts`
- Test: `scripts/test-agent-view.mjs` (Playwright; launch recipe as in `scripts/test-telemetry-ui.mjs`'s header, with `SCOTTY_OPENCODE_BIN` = the stub and an isolated `XDG_CONFIG_HOME`)

**Interfaces:**
- Consumes: Task 6 routes.
- Produces:
  - `lib/views.ts`: `"agent"` added to `VIEWS`; `VIEW_NAV` entry `{ key: "agent", label: "Agent", icon: "feature" }` placed after `needsyou`; `navViews(gamification: boolean, opts?: { agent?: boolean })` (default `agent: true`); sidebar and palette pass `agent: !readOnly`.
  - `api.agentStatus()`, `api.agentSession(projectId: string, beadId?: string): Promise<{sessionId: string; connectUrl: string; sessionUrl: string}>`.
  - `AppContext`: `agentBeadId: string | null`, `openAgent(beadId?: string): void` (sets the bead and switches `view` to `"agent"`).
  - `useAgentSignals(): { working: boolean; attention: number }` — `EventSource("/api/opencode/events")`; counts distinct session ids for `working`; `attention` is +1/-1 per `attention`/`attention-cleared`, floored at 0; on `tool-finished` invalidates the beads query (use the key from `hooks/use-beads.ts`).
  - `AgentView`: states loading / unavailable (`not_installed`: "OpenCode isn't available in this install", `start_failed`: message + Retry) / read-only message / ready. Ready renders `<iframe data-testid="agent-frame" src={connectUrl}>` and **on its first `load` event switches `src` to `sessionUrl`** (cookie is set by the first load). Starts a new session whenever `agentBeadId` changes.
  - Bead drawer: "Ask agent" button beside "Refine with AI" (hidden read-only) → `openAgent(bead.id)`.
  - Sidebar Agent item: `data-testid="agent-working"` pulsing dot while `working`; numeric badge `data-testid="agent-attention"` when `attention > 0`. Needs You view: banner "Agent is waiting on you" with an "Open Agent" button when `attention > 0`.
  - Stub additions: `GET /` → HTML containing `stub-opencode`; `GET /auth/connect/:code` → 302 `/` + `Set-Cookie: opencode_session_<port>=ok; HttpOnly; SameSite=Lax` once per code (reuse → 401); `GET /server/*/session/*` → HTML containing `stub-opencode session <id>`; a `GET /__log` returning every request it saw.

- [ ] **Step 1: Write the failing Playwright test:** with the stub: (a) sidebar has "Agent"; clicking shows the iframe and, inside it, the text `stub-opencode session`; the stub log shows exactly one `/auth/connect/<code>` for the visit; (b) opening a bead → "Ask agent" → Agent view, stub log shows a `PUT …/instructions/entries/scotty.context` whose value contains the bead id; (c) `POST /__emit` of `session.execution.started` shows `agent-working`, of `permission.asked` shows `agent-attention` = 1 and the Needs You banner, of `session.idle`/`permission.replied` clears them; (d) `SCOTTY_OPENCODE_BIN=/nonexistent` server → "isn't available" state; (e) in read-only mode (`SCOTTY_READ_ONLY=1`) the Agent nav item is absent and `POST /api/opencode/session` returns 403; (f) opening the same Scotty via `http://127.0.0.1:<port>` yields `connectUrl` starting `http://127.0.0.1:`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the files above following existing component patterns (`needs-you-view.tsx`, `ai-assist-panel.tsx`; existing `useLastView` makes `agent` URL-addressable automatically — confirm `isView` covers it).
- [ ] **Step 4: Run** the test → PASS; run `scripts/test-read-only.mjs`, `scripts/test-url-navigation.mjs`, `scripts/test-mobile-navigation.mjs` to confirm the new view did not regress navigation; `npm run lint`.
- [ ] **Step 5: Checkpoint.**

### Task 8: Docs and end-to-end verification with the real binary

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README section** "Agent (OpenCode)": what it is, pinned version, isolation (own data/config, your `~/.config/opencode` is only copied from), what is and isn't imported (agents/skills/providers yes; plugins/MCP/`auth.json` no), sign-in once inside the panel for providers that need it, `SCOTTY_OPENCODE_BIN`, the Settings switch, and the limitation that the Docker image does not include the agent (standalone output does not trace the binary) — the Agent view shows "unavailable" there.
- [ ] **Step 2: Real-binary run.** Record `date` marker; start Scotty (`npm run build && npm start`, isolated `XDG_CONFIG_HOME` for Scotty's own config but real `HOME`); open `http://localhost:<port>`, Agent view: confirm the iframe lands on a session (not the project list). If `sessionUrl`'s server segment is wrong, fix `lib/opencode/urls.ts` and its test. Confirm in the embedded UI that the `scotty` agent is selected and your agents/skills appear, your old sessions do not.
- [ ] **Step 3: Isolation proof.** `find ~/.config/opencode ~/.local/share/opencode -newer <marker> -not -path '*/log/*'` is empty (nothing in the real dirs was touched by Scotty's instance; ignore your own interactive edits and the real service's own log/db activity—compare against a second run with Scotty stopped if anything appears). `opencode service status` still shows the shared service unaffected.
- [ ] **Step 4: Inference check.** With a provider that has working credentials in the Scotty instance, send "hello" in the embedded session and run Refine with AI on a bead with provider set to OpenCode; record the result. If Bedrock/`ailab` fails with expired SSO, run `aws sso login --profile ailab` first and retry; if it still fails, record the exact error in the spec's Open items.
- [ ] **Step 5: Final gate:** `npm run lint`, `npx tsc --noEmit`, `npm run build`, then every new `scripts/test-opencode-*.mjs`, `test-ai-provider.mjs`, `test-agent-view.mjs`, plus `test-request-guard.mjs` and `test-read-only.mjs`. Stop any Scotty/OpenCode processes you started (kill by pid/port, never `pkill -f "opencode serve"`).
- [ ] **Step 6: Checkpoint** — `git status --short` lists only intended files; nothing committed.
