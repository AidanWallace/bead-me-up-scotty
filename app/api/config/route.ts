import { getConfig, saveConfig } from "@/lib/config";
import { resetStore } from "@/lib/store";
import { ok, fail } from "@/lib/api";
import { stopServer } from "@/lib/opencode/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  humanActor: z.string().optional(),
  humanAllowlist: z.array(z.string()).optional(),
  pollIntervalMs: z.number().int().min(1000).max(300000).optional(),
  gamification: z.boolean().optional(),
  aiProvider: z.enum(["auto", "opencode", "claude"]).optional(),
  importOpencodeConfig: z.boolean().optional(),
});

export async function GET() {
  return ok(getConfig());
}

export async function PUT(req: Request) {
  try {
    const patch = patchSchema.parse(await req.json());
    const prevImport = getConfig().importOpencodeConfig ?? true;
    const next = saveConfig(patch);
    if (patch.importOpencodeConfig !== undefined && patch.importOpencodeConfig !== prevImport) {
      // Config is synced at spawn; restart so the next session sees the new setting.
      stopServer();
    }
    // Actor changes affect write attribution; drop cached stores so the next
    // write picks up the new value.
    resetStore();
    return ok(next);
  } catch (e) {
    return fail(e);
  }
}
