import { fail } from "@/lib/api";
import { isReadOnly } from "@/lib/config";
import { peekServer } from "@/lib/opencode/server";
import { subscribeEvents } from "@/lib/opencode/client";
import { mapEvent } from "@/lib/opencode/signals";

export const dynamic = "force-dynamic";

const KEEPALIVE_MS = 15_000;
const POLL_MS = 1000;

export async function GET(req: Request) {
  try {
    if (isReadOnly(req)) {
      return Response.json({ error: "Agent events are disabled in read-only mode.", code: "read_only" }, { status: 403 });
    }
    const ac = new AbortController();
    const abort = () => ac.abort();
    req.signal.addEventListener("abort", abort);
    const enc = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (s: string) => {
          try {
            controller.enqueue(enc.encode(s));
          } catch {
            abort();
          }
        };
        send(": connected\n\n");
        const ka = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
        try {
          while (!ac.signal.aborted) {
            const h = await peekServer().catch(() => null);
            if (!h) {
              await new Promise((r) => setTimeout(r, POLL_MS));
              continue;
            }
            try {
              for await (const ev of subscribeEvents(h, ac.signal)) {
                const sig = mapEvent(ev);
                if (sig) send(`data: ${JSON.stringify(sig)}\n\n`);
              }
            } catch {
              // upstream dropped; retry below
            }
            if (!ac.signal.aborted) await new Promise((r) => setTimeout(r, POLL_MS));
          }
        } finally {
          clearInterval(ka);
          req.signal.removeEventListener("abort", abort);
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      },
      cancel() {
        abort();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
    });
  } catch (e) {
    return fail(e);
  }
}
