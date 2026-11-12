# OpenCode session inside Scotty — design

Status: approved direction; revised 2026-11-12 after isolation + docs research. Uncommitted by request.

## Intent
Let users chat with an OpenCode agent inside Scotty's web UI, coupled to the board, instead of relying only on a one-shot `claude -p` call. OpenCode becomes the primary AI backend; Claude stays as a selectable backend.

## Goals
- An "Agent" view/drawer that embeds a live OpenCode session for the current project.
- "Ask agent" on a bead opens a session with that bead as context.
- A **separate, version-pinned OpenCode instance owned by Scotty**; it never touches the user's normal OpenCode service, data or config.
- Scotty-only agent and skills.
- "Refine with AI" works through either backend.

## Non-goals
- Syncing beads data (AGENTS.md: local-only).
- Removing Claude.
- Using the user's global plugins or MCP servers inside Scotty's instance.

## Anti-goals
- Leaking the `scotty` agent/skills into the user's regular OpenCode sessions (and vice versa).
- Writing into `~/.config/opencode`, `~/.local/share/opencode`, or the user's repos.
- Exposing the server beyond 127.0.0.1.

## Constraints
- OpenCode v2 only (https://opencode.ai/v2/docs/). The HTTP API is marked experimental and changes between minors (2.1.3 has `/api/experimental/generate`, 2.2.7 has `/api/experimental/generate/text`) → **exact version pin** and a thin adapter module so only one file knows endpoint shapes.
- This Next.js has breaking changes; read `node_modules/next/dist/docs/` before touching Next APIs.
- Request guard (`lib/request-guard.ts`, `proxy.ts`) and `next.config.ts` must allow the iframe origin.

## Approaches considered
1. Iframe the user's shared background service. Rejected: global config/skills leak; pairing codes tied to a shared server.
2. Native chat UI on `@opencode/client`. Deferred: highest cost; revisit only if the iframe limits us.
3. **Chosen:** Scotty spawns its own pinned `opencode serve` (private data/config/state, random port + password) and iframes its web UI, plus API/event coupling.
4. `@opencode/sdk` in-process host. Rejected: no HTTP listener means no web UI to embed; Scotty is Node/Next.
5. OpenCode desktop GUI plugin API. Rejected: desktop-only and experimental; Scotty is a web app.

## Design

### Install and version lock
- Add `@opencode/cli` as an **exact-pinned** dependency (currently `2.2.7`; MIT; per-platform binaries via optionalDependencies; works even when npm skips its postinstall). Launch `node_modules/.bin/opencode serve`.
- `OPENCODE_DISABLE_AUTOUPDATE=1`. Upgrades are a deliberate Scotty release.
- Provider setting `ai.provider` = `opencode` | `claude` (app config + Settings). Default: opencode.

### Isolation (verified)
Spawn with env:
- `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` → `<scotty app dir>/opencode/{data,state,cache}` (own DB, sessions, logs, plugin cache; existing user sessions do not appear).
- `OPENCODE_CONFIG_DIR` → `<scotty app dir>/opencode/config` (replaces the global config location; user's `~/.config/opencode` is not read).
- `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_PASSWORD=<random>`, `--hostname 127.0.0.1 --port <free>`.

### Read-only use of `~/.config/opencode` (verified)
- **Copy, never symlink.** A symlinked `opencode.jsonc` coincided with that real file being modified during testing (likely the user's own edit, but write-through cannot be ruled out). Copies are one-way.
- On each server start, Scotty regenerates its config dir: copy `agents/` and `skills/`; generate `opencode.jsonc` containing **only** `providers` (from the user's file, comments stripped) plus Scotty's own keys. Global `plugins` and `mcp` are deliberately **not** imported.
- Verified: the isolated server then lists the user's agents/skills, and Bedrock resolves as the default model from the copied `providers` block.
- Opt-out switch in Settings: "Import my OpenCode agents/skills" (default on).

### Credentials
- Do **not** copy `auth.json`: OAuth refresh tokens may rotate and could invalidate the user's main OpenCode login. Env/profile-based providers (e.g. Bedrock via AWS profile) work from the copied `providers` block; other providers: user signs in once inside the embedded UI.
- Unverified: a live generation against Bedrock hung in testing (probably expired AWS SSO for the `ailab` profile); the builder must verify end-to-end inference.

### Scotty agent, skills, safety
- Ship `scotty` agent and `scotty-ui` skill inside the Scotty package; copy into the config dir on start. `default_agent: "scotty"` (verified loads; `skill` description gates when it is offered).
- Permissions on `scotty`: `shell` ask by default, `shell: bd *` allow. Config-level `policies` hard-deny e.g. `shell:git push *` (policies cannot be overridden by project config).

### Embedding (verified spike)
- `POST /api/pair` (Basic `opencode:<pw>`, body `{}`) → `{code}`; iframe `src` = `http://<host>:<port>/auth/connect/<code>` → 302 `/` + cookie `opencode_session_<port>` (HttpOnly, `SameSite=Lax`). Codes are single-use (5 min).
- **Same-site rule:** use the hostname the user used for Scotty in the iframe URL (`localhost` vs `127.0.0.1` gave 401s).
- No frame-blocking headers; full UI renders.
- Create session: `POST /api/session` `{location:{directory}}`. Deep link: `/server/<base64url(serverUrl)>/session/<id>`.

### Refine with AI
- Use the one-shot `POST /api/experimental/generate/text` `{prompt, model?}` (no session needed) with the existing JSON-only prompt/parser. Provider chain: opencode → claude. `lib/ai.ts` becomes a provider interface; `assist` route and `AiAssistPanel` unchanged.

### Coupling to the board
- **Context push:** `PUT /api/experimental/session/{id}/instructions/entries/<key>` `{value}` tells the agent which bead/view the user has open.
- **Events:** subscribe to `GET /api/event` (SSE) server-side: `session.execution.*`/`session.idle` → "agent working" indicator; `permission.asked` and `form.created` → surface in Scotty's existing "Needs you" view; `session.tool.*` for `bd` calls → invalidate board queries immediately (the `.beads` watcher remains the baseline).
- Wrap every endpoint in one adapter module (`lib/opencode/…`) because the API is experimental.

### Lifecycle and security
- Start lazily on first Agent open; stop on Scotty exit; first location load takes ~2 s (show a spinner).
- Only kill our own child process (by pid/port).
- Hide the panel in viewer/remote mode. Password never in the address bar.

## Left to the builder
Module names, drawer vs tab layout, Settings placement, how to persist the pid/port, Windows path handling.

## Implementation notes (verified 2026-11-12 with the real 2.2.7 binary)
- Embedded session lands correctly: iframe `sessionUrl` base64url target is `http://<iframe host>:<port>` (the UI uses the origin it was loaded from), not hard-coded 127.0.0.1.
- Scotty's instance lists the `scotty` agent, `scotty-ui` + user skills, resolves Bedrock as the default model from the copied `providers`, and holds only its own sessions. Real `~/.config/opencode` untouched; the shared service stayed up.
- `POST /api/experimental/generate/text` returned a real refined description through Bedrock (Refine with AI via OpenCode).
- Amendment: the Agent view works only when Scotty is opened via `localhost`/`127.0.0.1` (server binds 127.0.0.1; IPv6 and LAN names return `host_unsupported`).
- Config-level `policies` hard-deny `shell:git push *`; `scotty` agent also asks for other shell commands, allows `bd *`.
- Generated `opencode.jsonc` is written 0600 (may contain provider keys). Toggling "import my OpenCode config" stops Scotty's own child so the next use re-syncs.
- Docker: the image installs the pinned CLI, sets `SCOTTY_OPENCODE_BIN`, fixed port `SCOTTY_OPENCODE_PORT=4096` bound to `0.0.0.0` inside the container (`SCOTTY_OPENCODE_HOST`), published as `127.0.0.1:4096:4096`; verified with `docker compose` (iframe session via the published port, read-only config mount). Absolute symlinks in `~/.config/opencode` need the config mounted at its host path too.

## Open items
- Deferred minors: see `.superpowers/sdd/*/progress.md` (cross-process start race, attention counter drift on reconnect, status shows pinned not live version, a toggle does not restart a server reused from another Scotty process).
