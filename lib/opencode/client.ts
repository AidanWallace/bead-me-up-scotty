import "server-only";
import type { ServerHandle } from "./server.ts";

export class OpencodeApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "OpencodeApiError";
    this.status = status;
  }
}

function authHeader(h: ServerHandle): string {
  return "Basic " + Buffer.from(`opencode:${h.password}`).toString("base64");
}

function locationQuery(directory: string): string {
  return new URLSearchParams({ "location[directory]": directory }).toString();
}

async function request(
  h: ServerHandle,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = { authorization: authHeader(h) };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(h.url + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new OpencodeApiError(res.status, `opencode ${method} ${path.split("?")[0]} failed: ${res.status}${detail ? ` ${detail}` : ""}`);
  }
  return res;
}

export async function pair(h: ServerHandle): Promise<string> {
  const res = await request(h, "POST", "/api/pair", {});
  const json = (await res.json()) as { code?: string };
  if (typeof json.code !== "string") throw new OpencodeApiError(res.status, "opencode pair: missing code");
  return json.code;
}

export async function createSession(h: ServerHandle, directory: string): Promise<string> {
  const res = await request(h, "POST", "/api/session", { location: { directory } });
  const json = (await res.json()) as { data?: { id?: string } };
  if (typeof json.data?.id !== "string") throw new OpencodeApiError(res.status, "opencode createSession: missing id");
  return json.data.id;
}

export async function generateText(
  h: ServerHandle,
  prompt: string,
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await request(h, "POST", `/api/experimental/generate/text?${locationQuery(directory)}`, { prompt }, signal);
  const json = (await res.json()) as { data?: { text?: string } };
  if (typeof json.data?.text !== "string") throw new OpencodeApiError(res.status, "opencode generateText: missing text");
  return json.data.text;
}

export async function putInstruction(h: ServerHandle, sessionId: string, key: string, value: string): Promise<void> {
  await request(
    h,
    "PUT",
    `/api/experimental/session/${encodeURIComponent(sessionId)}/instructions/entries/${encodeURIComponent(key)}`,
    { value },
  );
}

export async function* subscribeEvents(h: ServerHandle, signal: AbortSignal): AsyncIterable<unknown> {
  if (signal.aborted) return;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const res = await request(h, "GET", "/api/event", undefined, signal);
    if (!res.body) return;
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let data: string[] = [];
    const flush = (): unknown[] => {
      if (data.length === 0) return [];
      const text = data.join("\n");
      data = [];
      try {
        return [JSON.parse(text)];
      } catch {
        return [];
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r\n|\n|\r/)) >= 0) {
        const m = /^(\r\n|\n|\r)/.exec(buf.slice(idx))!;
        // a trailing lone \r may be half of a CRLF; wait for more input
        if (m[0] === "\r" && idx + 1 === buf.length) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + m[0].length);
        if (line === "") {
          for (const ev of flush()) yield ev;
        } else if (line.startsWith(":")) {
          continue;
        } else if (line.startsWith("data:")) {
          const v = line.slice(5);
          data.push(v.startsWith(" ") ? v.slice(1) : v);
        }
      }
    }
    for (const ev of flush()) yield ev;
  } catch (err) {
    if (signal.aborted) return;
    throw err;
  } finally {
    try {
      await reader?.cancel();
    } catch {
      // ignore
    }
  }
}
