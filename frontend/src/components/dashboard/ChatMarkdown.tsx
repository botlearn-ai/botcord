"use client";

import MarkdownContent, { type MentionTextCandidate } from "@/components/ui/MarkdownContent";
import MentionChip from "./MentionChip";

/** Shared mention presentation for room messages and owner-chat responses. */
export default function ChatMarkdown({ content, mentionCandidates }: {
  content: string;
  mentionCandidates?: MentionTextCandidate[];
}) {
  return <MarkdownContent content={content} mentionCandidates={mentionCandidates} renderMention={({ id, label }) => <MentionChip id={id} label={label} />} />;
}
