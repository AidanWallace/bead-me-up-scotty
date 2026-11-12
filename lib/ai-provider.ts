export type AiProvider = "opencode" | "claude";
export type AiProviderPref = "auto" | AiProvider;

export function resolveProvider(
  pref: AiProviderPref | undefined,
  avail: { opencode: boolean; claude: boolean },
): AiProvider | null {
  const order: AiProvider[] = pref === "claude" ? ["claude", "opencode"] : ["opencode", "claude"];
  return order.find((p) => avail[p]) ?? null;
}
