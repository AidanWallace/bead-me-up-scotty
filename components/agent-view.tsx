"use client";
import * as React from "react";
import { useApp } from "@/components/app-context";
import { Icon } from "@/components/icons";
import { api, ApiError } from "@/lib/api-client";

type Session = Awaited<ReturnType<typeof api.agentSession>>;
type Result =
  | { kind: "ready"; session: Session }
  | { kind: "error"; code?: string; message: string };
// Tagged with the request it answers, so a result for a previous bead reads as loading.
type State = { key: string; result: Result | null };

// React StrictMode re-runs effects; share the in-flight request so one visit starts one session.
const inflight = new Map<string, Promise<Session>>();
function startSession(projectId: string, beadId: string | null): Promise<Session> {
  const key = `${projectId}\u0000${beadId ?? ""}`;
  let p = inflight.get(key);
  if (!p) {
    p = api.agentSession(projectId, beadId ?? undefined).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** The embedded OpenCode web UI. Starts a fresh session for the current bead (if any). */
export function AgentView() {
  const { projectId, agentBeadId, readOnly } = useApp();
  const [attempt, setAttempt] = React.useState(0);
  const key = `${projectId}\u0000${agentBeadId ?? ""}\u0000${attempt}`;
  const [answered, setAnswered] = React.useState<State>({ key: "", result: null });
  const state: Result | { kind: "loading" } = answered.key === key && answered.result ? answered.result : { kind: "loading" };

  React.useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    startSession(projectId, agentBeadId).then(
      (session) => { if (!cancelled) setAnswered({ key, result: { kind: "ready", session } }); },
      (e: unknown) => {
        if (cancelled) return;
        const err = e instanceof ApiError ? e : null;
        setAnswered({ key, result: { kind: "error", code: err?.code, message: e instanceof Error ? e.message : "Could not start an agent session." } });
      },
    );
    return () => { cancelled = true; };
  }, [projectId, agentBeadId, attempt, readOnly, key]);

  const retry = () => setAttempt((n) => n + 1);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-6 py-4">
        <Icon name="feature" size={18} className="text-[var(--text-2)]" />
        <h1 className="text-[15px] font-[650]">Agent</h1>
        {agentBeadId && (
          <span className="font-mono text-[12px] text-[var(--text-3)]">· {agentBeadId}</span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {readOnly ? (
          <Message>Agent sessions are disabled in read-only mode.</Message>
        ) : state.kind === "loading" ? (
          <Message>Starting agent session…</Message>
        ) : state.kind === "error" ? (
          <ErrorState code={state.code} message={state.message} onRetry={retry} />
        ) : (
          <AgentFrame key={state.session.sessionId} session={state.session} />
        )}
      </div>
    </div>
  );
}

// The first load (connectUrl) sets the auth cookie and redirects; once it
// finishes, point the frame at the session itself.
function AgentFrame({ session }: { session: Session }) {
  const [src, setSrc] = React.useState(session.connectUrl);
  const switched = React.useRef(false);
  return (
    // No sandbox attribute: the OpenCode UI needs same-origin cookies and storage to work.
    <iframe
      data-testid="agent-frame"
      title="OpenCode agent"
      src={src}
      onLoad={() => {
        if (switched.current) return;
        switched.current = true;
        setSrc(session.sessionUrl);
      }}
      className="h-full w-full border-0 bg-[var(--surface)]"
    />
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <div className="p-10 text-center text-[13px] text-[var(--text-3)]">{children}</div>;
}

function ErrorState({ code, message, onRetry }: { code?: string; message: string; onRetry: () => void }) {
  if (code === "not_installed") return <Message>OpenCode isn&apos;t available in this install.</Message>;
  if (code === "demo_project") return <Message>Agent sessions need a real project. Add a project folder to use the agent.</Message>;
  if (code === "read_only") return <Message>Agent sessions are disabled in read-only mode.</Message>;
  if (code === "host_unsupported") return <Message>{message}</Message>;
  return (
    <div className="p-10 text-center text-[13px] text-[var(--text-3)]">
      <p className="mb-3">{message}</p>
      {code === "start_failed" && (
        <button
          onClick={onRetry}
          className="h-8 rounded-lg border border-border bg-[var(--surface-2)] px-3 text-[12.5px] font-[550] text-[var(--text-2)] hover:bg-[var(--surface-3)]"
        >
          Retry
        </button>
      )}
    </div>
  );
}
