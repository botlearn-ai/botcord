import {
  RUNTIME_FRAME_TYPES,
  type GatewayInboundFrame,
} from "@botcord/protocol-core";

import type {
  ChannelAdapter,
  ChannelSendContext,
  ChannelSendResult,
  ChannelStatusSnapshot,
  Gateway,
  GatewayInboundMessage,
  GatewayLogger,
} from "./gateway/index.js";

export interface CloudGatewayRuntimeResult {
  accepted: boolean;
  eventId: string;
  gatewayId: string;
  agentId: string;
  conversationId: string;
  turnId: string;
  outbound?: {
    finalText: string;
    providerMessageId?: string | null;
  };
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Execute one ingress-originated runtime frame through the normal Gateway
 * dispatcher while keeping provider I/O outside the cloud sandbox.
 *
 * The temporary channel is scoped to this call and implements only the
 * dispatcher-facing send/status surface. Its send() method captures the
 * final runtime reply; the Hub relay converts that into
 * gateway_outbound_complete for gateway-ingress, which then calls the real
 * provider API.
 */
export async function handleCloudGatewayRuntimeInbound(
  gateway: Gateway,
  frame: GatewayInboundFrame,
  log?: GatewayLogger,
): Promise<CloudGatewayRuntimeResult> {
  if (frame.type !== RUNTIME_FRAME_TYPES.GATEWAY_INBOUND) {
    return rejected(frame, "bad_frame_type", `unsupported frame type "${frame.type}"`);
  }
  if (!frame.gateway_id || !frame.agent_id || !frame.event_id) {
    return rejected(frame, "bad_frame", "gateway_id, agent_id and event_id are required");
  }
  if (frame.message.accountId !== frame.agent_id) {
    return rejected(frame, "account_mismatch", "message.accountId does not match frame.agent_id");
  }
  if (frame.message.channel !== frame.gateway_id) {
    return rejected(frame, "channel_mismatch", "message.channel does not match frame.gateway_id");
  }

  let accepted = false;
  let outboundText: string | null = null;
  let providerMessageId: string | null | undefined;
  const channel = createRuntimeRelayChannel({
    id: frame.gateway_id,
    provider: frame.provider,
    accountId: frame.agent_id,
    onSend: async (ctx) => {
      outboundText = ctx.message.text ?? "";
      providerMessageId = ctx.message.traceId ?? null;
      return { providerMessageId };
    },
  });

  const message: GatewayInboundMessage = {
    ...frame.message,
    raw: {
      source_type: "cloud_gateway_ingress",
      provider: frame.provider,
      event_id: frame.event_id,
      gateway_id: frame.gateway_id,
    },
  };

  try {
    await gateway.injectInboundThrough(message, channel, {
      accept: async () => {
        accepted = true;
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.warn("cloud gateway runtime dispatch failed", {
      eventId: frame.event_id,
      gatewayId: frame.gateway_id,
      agentId: frame.agent_id,
      error: message,
    });
    return rejected(frame, "dispatch_failed", message);
  }

  return {
    accepted,
    eventId: frame.event_id,
    gatewayId: frame.gateway_id,
    agentId: frame.agent_id,
    conversationId: frame.message.conversation.id,
    turnId: `turn_${frame.event_id}`,
    ...(outboundText !== null
      ? {
          outbound: {
            finalText: outboundText,
            providerMessageId: providerMessageId ?? null,
          },
        }
      : {}),
    ...(!accepted
      ? { error: { code: "not_accepted", message: "dispatcher did not accept inbound" } }
      : {}),
  };
}

function createRuntimeRelayChannel(opts: {
  id: string;
  provider: string;
  accountId: string;
  onSend: (ctx: ChannelSendContext) => Promise<ChannelSendResult>;
}): ChannelAdapter {
  let lastSendAt: number | undefined;
  return {
    id: opts.id,
    type: opts.provider,
    async start() {
      return undefined;
    },
    async stop() {
      return undefined;
    },
    async send(ctx) {
      lastSendAt = Date.now();
      return opts.onSend(ctx);
    },
    status(): ChannelStatusSnapshot {
      return {
        channel: opts.id,
        accountId: opts.accountId,
        running: true,
        connected: true,
        authorized: true,
        provider: opts.provider as ChannelStatusSnapshot["provider"],
        ...(lastSendAt ? { lastSendAt } : {}),
      };
    },
  };
}

function rejected(
  frame: Partial<GatewayInboundFrame>,
  code: string,
  message: string,
): CloudGatewayRuntimeResult {
  return {
    accepted: false,
    eventId: frame.event_id ?? "",
    gatewayId: frame.gateway_id ?? "",
    agentId: frame.agent_id ?? "",
    conversationId: frame.message?.conversation.id ?? "",
    turnId: frame.event_id ? `turn_${frame.event_id}` : "turn_unknown",
    error: { code, message },
  };
}
