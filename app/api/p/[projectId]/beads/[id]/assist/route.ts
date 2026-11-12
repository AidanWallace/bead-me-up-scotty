import { getStore } from "@/lib/store";
import { ok, fail } from "@/lib/api";
import { assistBead } from "@/lib/ai";
import { getConfig, getProject } from "@/lib/config";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string; id: string }> };

/** Refine/triage a bead with the configured AI provider. Read-only — returns
 *  suggestions; the client applies them only on explicit confirmation. */
export async function POST(_req: Request, { params }: Ctx) {
  try {
    const { projectId, id } = await params;
    const store = await getStore(projectId);
    const beads = await store.list();
    const bead = beads.find((b) => b.id === id);
    if (!bead) return fail(new Error(`Unknown bead: ${id}`));

    const project = getProject(projectId);
    const result = await assistBead(
      {
        id: bead.id,
        title: bead.title,
        description: bead.description ?? "",
        type: bead.issue_type,
        labels: bead.labels ?? [],
        others: beads.filter((b) => b.id !== id).map((b) => ({ id: b.id, title: b.title })),
      },
      { directory: project?.path ?? null, pref: getConfig().aiProvider },
    );
    return ok(result);
  } catch (e) {
    return fail(e);
  }
}
