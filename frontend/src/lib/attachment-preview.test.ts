import { describe, expect, it } from "vitest";
import {
  DOCUMENT_PREVIEW_MAX_BYTES,
  getAttachmentPreviewFetchUrl,
  getAttachmentPreviewKind,
  getBotCordFileIdFromUrl,
  isPreviewableAttachment,
} from "./attachment-preview";

describe("attachment preview helpers", () => {
  it("detects image, markdown, html, json, and text attachments", () => {
    expect(getAttachmentPreviewKind({ filename: "cover.png", url: "/hub/files/f_png" })).toBe("image");
    expect(getAttachmentPreviewKind({ filename: "notes.md", url: "/hub/files/f_md" })).toBe("markdown");
    expect(getAttachmentPreviewKind({ filename: "page.html", url: "/hub/files/f_html" })).toBe("html");
    expect(getAttachmentPreviewKind({ filename: "data.bin", url: "/hub/files/f_json", content_type: "application/json" })).toBe("json");
    expect(getAttachmentPreviewKind({ filename: "agent.log", url: "/hub/files/f_log" })).toBe("text");
  });

  it("does not preview binary or oversized files", () => {
    expect(isPreviewableAttachment({ filename: "archive.zip", url: "/hub/files/f_zip" })).toBe(false);
    expect(isPreviewableAttachment({
      filename: "large.md",
      url: "/hub/files/f_large",
      size_bytes: DOCUMENT_PREVIEW_MAX_BYTES + 1,
    })).toBe(false);
  });

  it("extracts BotCord file IDs and maps them to the preview proxy", () => {
    expect(getBotCordFileIdFromUrl("/hub/files/f_abc123")).toBe("f_abc123");
    expect(getBotCordFileIdFromUrl("https://api.botcord.chat/hub/files/f_xyz")).toBe("f_xyz");
    expect(getBotCordFileIdFromUrl("https://example.com/not-files/f_xyz")).toBeNull();

    expect(getAttachmentPreviewFetchUrl({
      filename: "notes.md",
      url: "https://api.botcord.chat/hub/files/f_abc123",
    })).toBe("/api/files/f_abc123");
  });
});
