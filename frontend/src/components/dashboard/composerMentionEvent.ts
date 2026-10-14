export const COMPOSER_MENTION_EVENT = "botcord:composer-mention";
export interface ComposerMentionDetail {
  roomId: string;
  participantId: string;
}
export function emitComposerMention(detail: ComposerMentionDetail) {
  window.dispatchEvent(new CustomEvent(COMPOSER_MENTION_EVENT, { detail }));
}
