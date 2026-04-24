import type {
  GatewayConfig,
  GatewayInboundMessage,
  GatewayRoute,
  RouteMatch,
} from "./types.js";

/** Returns true if every provided field of `match` matches `message`; undefined match matches all. */
export function matchesRoute(
  message: GatewayInboundMessage,
  match: RouteMatch | undefined,
): boolean {
  if (!match) return true;
  if (match.channel !== undefined && match.channel !== message.channel) return false;
  if (match.accountId !== undefined && match.accountId !== message.accountId) return false;
  if (match.conversationId !== undefined && match.conversationId !== message.conversation.id) {
    return false;
  }
  if (
    match.conversationPrefix !== undefined &&
    !message.conversation.id.startsWith(match.conversationPrefix)
  ) {
    return false;
  }
  if (
    match.conversationKind !== undefined &&
    match.conversationKind !== message.conversation.kind
  ) {
    return false;
  }
  if (match.senderId !== undefined && match.senderId !== message.sender.id) return false;
  if (match.mentioned !== undefined) {
    const actual = message.mentioned ?? false;
    if (match.mentioned !== actual) return false;
  }
  return true;
}

/**
 * Picks the first matching route in priority order:
 *   1. `config.routes[]` entries whose `match.accountId` names this message's
 *      accountId — explicit operator override for a specific agent.
 *   2. `managedRoutes` (daemon-synthesized per-agent, reflects the runtime
 *      the user picked when provisioning the agent). Broad user routes do
 *      NOT clobber this, because the agent's runtime is itself an explicit
 *      user choice — a catch-all prefix rule shouldn't silently downgrade it.
 *   3. Remaining `config.routes[]` (broad prefix/kind/channel rules).
 *   4. `config.defaultRoute`.
 */
export function resolveRoute(
  message: GatewayInboundMessage,
  config: Pick<GatewayConfig, "defaultRoute" | "routes">,
  managedRoutes?: readonly GatewayRoute[],
): GatewayRoute {
  const routes = config.routes ?? [];

  for (const route of routes) {
    if (route.match?.accountId === message.accountId && matchesRoute(message, route.match)) {
      return route;
    }
  }

  if (managedRoutes) {
    for (const route of managedRoutes) {
      if (matchesRoute(message, route.match)) return route;
    }
  }

  for (const route of routes) {
    if (matchesRoute(message, route.match)) return route;
  }

  return config.defaultRoute;
}
