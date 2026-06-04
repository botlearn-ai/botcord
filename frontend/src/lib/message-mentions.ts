export interface MessageMentionTarget {
  id: string;
  label: string;
}

export interface MessageMentionCandidate {
  id: string;
  label: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMentionBoundaryPattern(label: string): RegExp {
  return new RegExp(`(^|[\\s([{'"“‘])@${escapeRegExp(label)}(?=$|[\\s.,!?;:()[\\]{}'"“”‘’])`, "i");
}

export function normalizeMessageMentions(mentions: unknown): string[] {
  if (!Array.isArray(mentions)) return [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const mention of mentions) {
    if (typeof mention !== "string") continue;
    const id = mention.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }

  return result;
}

export function messageTextContainsMentionTarget(
  text: string,
  target: MessageMentionTarget,
): boolean {
  if (!text) return false;
  if (target.id !== "@all" && text.includes(`(${target.id})`)) return true;

  const labels = new Set<string>();
  if (target.id === "@all") {
    labels.add("all");
  } else {
    labels.add(target.label);
    labels.add(target.id);
  }

  for (const label of labels) {
    if (label && isMentionBoundaryPattern(label).test(text)) return true;
  }
  return false;
}

export function resolveMessageMentionTargets(
  mentions: unknown,
  candidates: MessageMentionCandidate[] = [],
  text: string = "",
): MessageMentionTarget[] {
  const normalized = normalizeMessageMentions(mentions);
  if (normalized.length === 0) return [];

  return normalized
    .map((id) => {
      if (id === "@all") return { id, label: "all" };
      const candidate = candidates.find((item) => item.id === id);
      return { id, label: candidate?.label || id };
    })
    .filter((target) => !messageTextContainsMentionTarget(text, target));
}
