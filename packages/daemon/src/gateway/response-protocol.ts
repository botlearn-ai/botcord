import type { GatewayInboundMessage } from "./types.js";

/** Only actual delivered inputs belong to a run; history/quotes do not. */
export function responseInputIds(msg: GatewayInboundMessage): string[] {
  const raw = msg.raw as { batch?: unknown[]; envelope?: { msg_id?: unknown; type?: unknown } } | undefined;
  const entries = Array.isArray(raw?.batch) ? raw.batch : [raw];
  return [...new Set(entries.flatMap((entry) => {
    const env = (entry as typeof raw)?.envelope;
    return env?.type === "message" && typeof env.msg_id === "string" ? [env.msg_id] : [];
  }))];
}

export function responseInstructions(runId: string, roomId: string, ids: string[], restricted: boolean): string {
  const context = `[BotCord response execution: ${runId}; room: ${roomId}; input message IDs: ${ids.join(",")}. Historical messages and quotes are context, not additional inputs.\n`;
  const structured = ids.length === 1 ? "For automatic final-text delivery, reply with ordinary final text, or exactly NO_REPLY when no response is needed.\n" : 'For automatic final-text delivery, you may return exactly <botcord-response>{"responds_to":["message-id"],"no_reply":["other-id"],"text":"your final reply"}</botcord-response>. Only include IDs from this execution. A bare NO_REPLY resolves only a single-input execution; for a batch name each no_reply target.\n';
  if (restricted) return context + structured + "A plain final reply is associated automatically only when there is one input.]\n\n";
  return context +
    `Before working, declare targets: botcord response start --run-id ${runId} --room ${roomId} --messages <id,id>. ` +
    `For messages needing no response: botcord response no-reply --run-id ${runId} --room ${roomId} --messages <id,id>. ` +
    `To send, use botcord send --to ${roomId} --run-id ${runId} --responds-to <id,id> --response-kind progress|final --message-id <stable-uuid> --text "...". Reuse the message UUID when retrying the SAME send. Ordinary unassociated sends do not resolve inputs.\n` + structured + "]\n\n";
}

export function parseResponseDecision(text: string, inputIds: string[]): { respondsTo: string[]; noReply: string[]; text: string } | null {
  if (!text.startsWith("<botcord-response>")) return null;
  const match = /^<botcord-response>([\s\S]*)<\/botcord-response>$/.exec(text);
  if (!match) throw new Error("Invalid response decision envelope");
  const value = JSON.parse(match[1]!) as { responds_to?: unknown; no_reply?: unknown; text?: unknown };
  const ids = (raw: unknown): string[] => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string" || !inputIds.includes(id))) throw new Error("Invalid response decision targets");
    return [...new Set(raw as string[])];
  };
  const respondsTo = ids(value.responds_to);
  const noReply = ids(value.no_reply);
  if (respondsTo.some((id) => noReply.includes(id)) || typeof value.text !== "string" || (value.text.trim() && !respondsTo.length) || (respondsTo.length && !value.text.trim())) throw new Error("Conflicting response decision");
  return { respondsTo, noReply, text: value.text };
}
