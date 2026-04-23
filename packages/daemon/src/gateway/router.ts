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

/** Picks the first matching route from config.routes; falls back to config.defaultRoute. */
export function resolveRoute(
  message: GatewayInboundMessage,
  config: Pick<GatewayConfig, "defaultRoute" | "routes">,
): GatewayRoute {
  const routes = config.routes ?? [];
  for (const route of routes) {
    if (matchesRoute(message, route.match)) return route;
  }
  return config.defaultRoute;
}
