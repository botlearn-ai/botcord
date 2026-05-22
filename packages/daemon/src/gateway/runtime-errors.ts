/**
 * Runtime CLIs sometimes report authentication failures as ordinary final
 * text. Keep this intentionally narrow so normal model replies about auth do
 * not get reclassified unless they look like a top-level CLI/API failure.
 */
export function looksLikeRuntimeAuthFailure(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  return (
    /^(Failed to authenticate|Authentication failed|Invalid API key|Invalid Anthropic API key)\b/i.test(s) ||
    /^API Error:\s*4\d\d\b/i.test(s) ||
    /\b(API Error:\s*4\d\d|Request not allowed|invalid x-api-key)\b/i.test(s) ||
    /^(Unauthorized|Forbidden)(?:\b|:)/i.test(s)
  );
}
