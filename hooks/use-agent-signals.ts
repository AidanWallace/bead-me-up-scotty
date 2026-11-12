"use client";
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useApp } from "@/components/app-context";
import { beadsKey } from "@/hooks/use-beads";

export type AgentSignals = { working: boolean; attention: number };

const IDLE: AgentSignals = { working: false, attention: 0 };

// One EventSource is shared by every consumer (sidebar, mobile sheet, Needs You).
const working = new Set<string>();
let attention = 0;
let snapshot: AgentSignals = IDLE;
let source: EventSource | null = null;
let refs = 0;
const listeners = new Set<() => void>();
let onToolFinished: (() => void) | null = null;

function publish() {
  const next = { working: working.size > 0, attention };
  if (next.working === snapshot.working && next.attention === snapshot.attention) return;
  snapshot = next.working || next.attention > 0 ? next : IDLE;
  for (const l of listeners) l();
}

function handle(raw: string) {
  let sig: { kind?: string; sessionId?: string };
  try {
    sig = JSON.parse(raw);
  } catch {
    return;
  }
  const id = sig.sessionId ?? "";
  switch (sig.kind) {
    case "working":
      working.add(id);
      break;
    case "idle":
      working.delete(id);
      break;
    case "attention":
      attention += 1;
      break;
    case "attention-cleared":
      attention = Math.max(0, attention - 1);
      break;
    case "tool-finished":
      onToolFinished?.();
      return;
    default:
      return;
  }
  publish();
}

// The first consumer's handler serves the whole shared stream (all consumers share a project).
function acquire(onTool: () => void) {
  if (refs++ > 0) return;
  onToolFinished = onTool;
  source = new EventSource("/api/opencode/events");
  source.onmessage = (e) => handle(e.data);
}

function release() {
  if (--refs > 0) return;
  source?.close();
  source = null;
  onToolFinished = null;
  working.clear();
  attention = 0;
  publish();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** Live agent state from the OpenCode server (idle in read-only mode, where the stream is refused). */
export function useAgentSignals(): AgentSignals {
  const { readOnly, projectId } = useApp();
  const queryClient = useQueryClient();
  const state = React.useSyncExternalStore(subscribe, () => snapshot, () => IDLE);

  React.useEffect(() => {
    if (readOnly) return;
    acquire(() => void queryClient.invalidateQueries({ queryKey: beadsKey(projectId) }));
    return release;
  }, [readOnly, queryClient, projectId]);

  return readOnly ? IDLE : state;
}
