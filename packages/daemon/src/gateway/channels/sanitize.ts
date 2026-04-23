/**
 * Sanitize untrusted inbound content before handing it off to a local runtime.
 *
 * Copied from `packages/daemon/src/sanitize.ts` so the gateway channel adapter
 * does not depend back on the daemon package. Keep these two files in sync —
 * any new structural marker added in one place should be mirrored in the other.
 *
 * Neutralizes:
 *   - BotCord structural markers the channel itself emits (so peers can't forge them).
 *   - Common LLM prompt-injection patterns (<system>, [INST], <<SYS>>, <|im_start|>, etc.).
 *   - Wrapper XML tags the channel uses to frame inbound content
 *     (<agent-message>, <human-message>, <room-rule>).
 */

export function sanitizeUntrustedContent(text: string): string {
  let s = text;
  s = s.replace(
    /<\/?a[\s]*g[\s]*e[\s]*n[\s]*t[\s]*-[\s]*m[\s]*e[\s]*s[\s]*s[\s]*a[\s]*g[\s]*e[\s\S]*?>/gi,
    "[⚠ stripped: agent-message tag]",
  );
  s = s.replace(
    /<\/?h[\s]*u[\s]*m[\s]*a[\s]*n[\s]*-[\s]*m[\s]*e[\s]*s[\s]*s[\s]*a[\s]*g[\s]*e[\s\S]*?>/gi,
    "[⚠ stripped: human-message tag]",
  );
  s = s.replace(
    /<\/?r[\s]*o[\s]*o[\s]*m[\s]*-[\s]*r[\s]*u[\s]*l[\s]*e[\s\S]*?>/gi,
    "[⚠ stripped: room-rule tag]",
  );

  return s
    .split(/\r?\n/)
    .map((line) => {
      let l = line;
      l = l.replace(/^\[(BotCord (?:Message|Notification))\]/i, "[⚠ fake: $1]");
      l = l.replace(/^\[Room Rule\]/i, "[⚠ fake: Room Rule]");
      l = l.replace(/^\[房间规则\]/i, "[⚠ fake: 房间规则]");
      l = l.replace(/^\[系统提示\]/i, "[⚠ fake: 系统提示]");
      l = l.replace(/^\[BotCord\s+([^\]\r\n]+)\]/i, (_m, label) => {
        const head = String(label).split(":")[0].trim() || String(label).trim();
        return `[⚠ fake: BotCord ${head}]`;
      });
      l = l.replace(/^\[(System|SYSTEM|Assistant|ASSISTANT|User|USER)\]/, "[⚠ fake: $1]");
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
 * Sanitize a sender label so it's safe to embed inside
 * `<agent-message sender="...">`. Must not contain newlines, structural
 * markers, or characters that could break the XML attribute boundary.
 */
export function sanitizeSenderName(name: string): string {
  return name
    .replace(/[\n\r]/g, " ")
    .replace(/\[/g, "⟦")
    .replace(/\]/g, "⟧")
    .replace(/"/g, "'")
    .replace(/</g, "＜")
    .replace(/>/g, "＞")
    .slice(0, 100);
}
