export type AgentSignal = {
  kind: "working" | "idle" | "attention" | "attention-cleared" | "tool-finished";
  sessionId: string;
};

const KINDS: Record<string, AgentSignal["kind"]> = {
  "session.execution.started": "working",
  "session.execution.succeeded": "idle",
  "session.execution.failed": "idle",
  "session.execution.interrupted": "idle",
  "session.idle": "idle",
  "permission.asked": "attention",
  "form.created": "attention",
  "permission.replied": "attention-cleared",
  "form.replied": "attention-cleared",
  "form.cancelled": "attention-cleared",
  "session.tool.success": "tool-finished",
};

export function mapEvent(ev: unknown): AgentSignal | null {
  try {
    if (!ev || typeof ev !== "object") return null;
    const e = ev as { type?: unknown; data?: unknown; durable?: unknown };
    if (typeof e.type !== "string" || !Object.hasOwn(KINDS, e.type)) return null;
    const data = e.data && typeof e.data === "object" ? (e.data as { sessionID?: unknown }) : null;
    const durable = e.durable && typeof e.durable === "object" ? (e.durable as { aggregateID?: unknown }) : null;
    const sessionId =
      typeof data?.sessionID === "string"
        ? data.sessionID
        : typeof durable?.aggregateID === "string"
          ? durable.aggregateID
          : "";
    return { kind: KINDS[e.type], sessionId };
  } catch {
    return null;
  }
}
