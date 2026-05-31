import { describe, expect, it } from "vitest";
import {
  hasFailedAttachmentImageUrl,
  isImageAttachment,
  rememberFailedAttachmentImageUrl,
  resolveAttachmentUrl,
} from "./AttachmentItem";

describe("AttachmentItem helpers", () => {
  it("resolves hub-relative attachment URLs", () => {
    expect(resolveAttachmentUrl("/hub/files/f_123")).toBe("https://api.botcord.chat/hub/files/f_123");
  });

  it("detects image attachments by MIME type or filename extension", () => {
    expect(isImageAttachment({
      filename: "screenshot.bin",
      url: "/hub/files/f_123",
      content_type: "image/png",
    })).toBe(true);

    expect(isImageAttachment({
      filename: "diagram.webp",
      url: "/hub/files/f_456",
    })).toBe(true);

    expect(isImageAttachment({
      filename: "report.pdf",
      url: "/hub/files/f_789",
    })).toBe(false);
  });

  it("remembers failed image attachment URLs for the current session", () => {
    const attachmentUrl = "https://api.botcord.chat/hub/files/f_failed_session_test";

    expect(hasFailedAttachmentImageUrl(attachmentUrl)).toBe(false);

    rememberFailedAttachmentImageUrl(` ${attachmentUrl} `);

    expect(hasFailedAttachmentImageUrl(attachmentUrl)).toBe(true);
  });
});
