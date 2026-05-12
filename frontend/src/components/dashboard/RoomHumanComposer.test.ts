import { describe, expect, it, vi } from "vitest";
import { uploadRoomAttachments } from "./RoomHumanComposer";

vi.mock("@/lib/api", () => ({
  api: {
    uploadFile: vi.fn(),
  },
}));

describe("uploadRoomAttachments", () => {
  it("uploads files with the selected agent and maps upload metadata to attachments", async () => {
    const file = { name: "report.pdf" } as File;
    const uploadFile = vi.fn(async () => ({
      file_id: "f_123",
      url: "https://api.example.test/hub/files/f_123",
      original_filename: "report.pdf",
      content_type: "application/pdf",
      size_bytes: 42,
      expires_at: "2026-05-12T00:00:00Z",
    }));

    await expect(uploadRoomAttachments([file], "ag_owner", uploadFile)).resolves.toEqual([
      {
        filename: "report.pdf",
        url: "https://api.example.test/hub/files/f_123",
        content_type: "application/pdf",
        size_bytes: 42,
      },
    ]);
    expect(uploadFile).toHaveBeenCalledWith(file, "ag_owner");
  });

  it("requires an owned agent for file uploads", async () => {
    await expect(uploadRoomAttachments([{ name: "report.pdf" } as File], null)).rejects.toThrow(
      "Choose or create an agent before sending files.",
    );
  });
});
