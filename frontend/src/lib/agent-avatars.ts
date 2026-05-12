export const AGENT_AVATAR_URLS = Array.from(
  { length: 43 },
  (_, index) => `/agent-avatars/${index + 1}.png`,
);

export function isAgentAvatarUrl(value: string | null | undefined): value is string {
  return typeof value === "string" && AGENT_AVATAR_URLS.includes(value);
}
