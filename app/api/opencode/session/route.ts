import { NextResponse } from "next/server";
import { z } from "zod";
import { fail } from "@/lib/api";
import { getProject, isReadOnly } from "@/lib/config";
import { getStore } from "@/lib/store";
import { ensureServer, OpencodeUnavailableError } from "@/lib/opencode/server";
import { createSession, pair, putInstruction } from "@/lib/opencode/client";
import { connectUrl, iframeHost, isLoopbackHost, sessionUrl } from "@/lib/opencode/urls";

export const dynamic = "force-dynamic";

const Body = z.object({ projectId: z.string().min(1), beadId: z.string().min(1).optional() });

function err(code: string, error: string, status: number) {
  return NextResponse.json({ error, code }, { status });
}

export async function POST(req: Request) {
  try {
    if (isReadOnly(req)) return err("read_only", "Agent sessions are disabled in read-only mode.", 403);
    const { projectId, beadId } = Body.parse(await req.json());
    const project = getProject(projectId);
    if (!project) return err("unknown_project", `Unknown project: ${projectId}`, 404);
    if (project.path === null) return err("demo_project", "The demo project has no directory for an agent session.", 400);

    const host = iframeHost(req.headers.get("host"));
    if (!isLoopbackHost(host)) {
      return err("host_unsupported", `The agent UI is only reachable via localhost or 127.0.0.1 (got ${host}).`, 400);
    }

    let title: string | null = null;
    if (beadId) {
      const store = await getStore(projectId);
      title = (await store.list()).find((b) => b.id === beadId)?.title ?? null;
    }

    const h = await ensureServer();
    const sessionId = await createSession(h, project.path);
    if (beadId) {
      const label = title ? ` “${title}”` : "";
      await putInstruction(
        h,
        sessionId,
        "scotty.context",
        `The user is looking at bead ${beadId}${label} in Scotty; use bd to read or update it.`,
      );
    }
    const code = await pair(h);
    return NextResponse.json({
      sessionId,
      connectUrl: connectUrl(host, h.port, code),
      sessionUrl: sessionUrl(host, h.port, sessionId),
    });
  } catch (e) {
    if (e instanceof OpencodeUnavailableError) return err(e.code, e.message, 503);
    return fail(e);
  }
}
