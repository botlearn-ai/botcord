export function extractTextFromEnvelope(envelopeData: Record<string, unknown>): {
  senderId: string;
  text: string;
  payload: Record<string, unknown>;
} {
  const senderId = (envelopeData.from as string) || "";
  const payload = (
    typeof envelopeData.payload === "object" && envelopeData.payload !== null
      ? envelopeData.payload
      : {}
  ) as Record<string, unknown>;
  let text = (payload.text || payload.body || payload.message || "") as string;
  if (typeof text !== "string") text = String(text);
  const msgType = (envelopeData.type as string) || "message";
  if (!text && msgType === "contact_request") {
    text = (payload.message || "") as string;
    if (typeof text !== "string") text = String(text);
  }
  return { senderId, text, payload };
}

export function escapeLike(q: string): string {
  return q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
