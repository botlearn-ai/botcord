/**
 * Sanitize untrusted message content by neutralizing BotCord structural markers.
 * Replaces fake [BotCord Message], [BotCord Notification], [Room Rule] prefixes
 * and common LLM prompt injection patterns.
 */
export function sanitizeUntrustedContent(text: string): string {
  // Strip wrapper XML tags on the full string BEFORE line splitting so that
  // multiline tags like `<agent-message\n sender="evil">` or tags with the
  // name itself split across lines (`<agent-\nmessage>`) are caught.
  let s = text;
  s = s.replace(/<\/?a[\s]*g[\s]*e[\s]*n[\s]*t[\s]*-[\s]*m[\s]*e[\s]*s[\s]*s[\s]*a[\s]*g[\s]*e[\s\S]*?>/gi, "[⚠ stripped: agent-message tag]");
  s = s.replace(/<\/?r[\s]*o[\s]*o[\s]*m[\s]*-[\s]*r[\s]*u[\s]*l[\s]*e[\s\S]*?>/gi, "[⚠ stripped: room-rule tag]");

  return s
    .split(/\r?\n/)
    .map(line => {
      let l = line;
      // Neutralize fake BotCord structural markers at line start
      l = l.replace(/^\[(BotCord (?:Message|Notification))\]/i, "[⚠ fake: $1]");
      l = l.replace(/^\[Room Rule\]/i, "[⚠ fake: Room Rule]");
      l = l.replace(/^\[房间规则\]/i, "[⚠ fake: 房间规则]");
      l = l.replace(/^\[系统提示\]/i, "[⚠ fake: 系统提示]");
      // Neutralize common LLM prompt injection markers (open and close tags)
      l = l.replace(/<\/?\s*system(?:-reminder)?\s*>/gi, "[⚠ stripped: system tag]");
      l = l.replace(/<\|im_start\|>/gi, "[⚠ stripped: im_start]");
      l = l.replace(/<\|im_end\|>/gi, "[⚠ stripped: im_end]");
      l = l.replace(/\[\/?INST\]/gi, "[⚠ stripped: INST]");
      l = l.replace(/<<\/?SYS>>/gi, "[⚠ stripped: SYS]");
      l = l.replace(/<\s*\/?\|(?:system|user|assistant)\|?\s*>/gi, "[⚠ stripped: role tag]");
      return l;
    })
    .join("\n");
}

/**
 * Sanitize sender name — must not contain newlines or structural markers.
 */
export function sanitizeSenderName(name: string): string {
  return name
    .replace(/[\n\r]/g, " ")
    .replace(/\[/g, "⟦").replace(/\]/g, "⟧")
    .slice(0, 100);
}
