import { NextResponse } from "next/server";
import { fail } from "@/lib/api";
import { peekServer, pinnedVersion, resolveOpencodeBin } from "@/lib/opencode/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const h = await peekServer();
    return NextResponse.json({
      available: resolveOpencodeBin() !== null,
      running: h !== null,
      version: h ? pinnedVersion() : null,
      pinned: pinnedVersion() ?? "",
    });
  } catch (e) {
    return fail(e);
  }
}
