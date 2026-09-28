export interface MentionMatch {
  start: number;
  query: string;
}

/** A mention starts at a text boundary, never inside an email address. */
export function detectMention(text: string, cursor: number): MentionMatch | null {
  const prefix = text.slice(0, cursor);
  const match = /(?:^|[\s，。！？、（(])[@＠]([^\s@＠]*)$/u.exec(prefix);
  if (!match) return null;
  return { start: cursor - match[1].length - 1, query: match[1] };
}

export function insertMentionTrigger(text: string, start: number, end: number) {
  const match = start === end ? detectMention(text, start) : null;
  if (match) return { text, cursor: start };
  const before = text.slice(0, start);
  const insert = `${before && !/[\s，。！？、（(]$/u.test(before) ? " " : ""}@`;
  return { text: before + insert + text.slice(end), cursor: start + insert.length };
}

export interface DraftMention {
  start: number;
  end: number;
  agent_id: string;
  display_name: string;
  id?: string;
}

/** Keep identity only for untouched selected names; editing a name makes it plain text. */
export function reconcileDraftMentions(before: string, after: string, mentions: DraftMention[], edit?: { start: number; end: number }): DraftMention[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  if (edit) start = Math.min(start, edit.start);
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > Math.max(start, edit?.end ?? start) && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  const delta = after.length - before.length;
  return mentions.flatMap((mention) => {
    let next = mention;
    if (mention.end <= start) {
      // The edit is after this mention.
    } else if (mention.start >= oldEnd) {
      next = { ...mention, start: mention.start + delta, end: mention.end + delta };
    } else {
      return [];
    }
    if (after.slice(next.start, next.end) !== `@${next.display_name}`) return [];
    const prev = after[next.start - 1];
    const following = after[next.end];
    if (prev && !/[\s，。！？、；：（）([{'"“‘]/u.test(prev)) return [];
    if (following && !/[\s，。！？、；：（）.,!?;:()[\]{}'"“”‘’]/u.test(following)) return [];
    return [next];
  });
}

/** The wire format retains IDs even though the editor shows only friendly names. */
export function serializeDraftMentions(text: string, mentions: DraftMention[]): string {
  let result = text;
  for (const mention of [...mentions].sort((a, b) => b.start - a.start)) {
    if (!mention.id) continue;
    result = result.slice(0, mention.end) + `(${mention.id})` + result.slice(mention.end);
  }
  return result;
}

export function hydrateMentionDraft(wireText: string): { text: string; mentions: DraftMention[] } {
  let text = "";
  let cursor = 0;
  const mentions: DraftMention[] = [];
  for (const match of wireText.matchAll(/@([^\n@]+?)\(((?:ag|hu|rm)_[^)]+)\)/g)) {
    text += wireText.slice(cursor, match.index);
    const start = text.length;
    text += `@${match[1]}`;
    mentions.push({ start, end: text.length, display_name: match[1], agent_id: match[2], id: match[2] });
    cursor = match.index! + match[0].length;
  }
  return { text: text + wireText.slice(cursor), mentions };
}
