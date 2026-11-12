export function iframeHost(hostHeader: string | null): string {
  const h = (hostHeader ?? "").trim();
  if (!h) return "localhost";
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  return h.split(":")[0] || "localhost";
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export function connectUrl(host: string, port: number, code: string): string {
  return `http://${host}:${port}/auth/connect/${code}`;
}

export function sessionUrl(host: string, port: number, sessionId: string): string {
  const target = Buffer.from(`http://${host}:${port}`).toString("base64url");
  return `http://${host}:${port}/server/${target}/session/${sessionId}`;
}
