import { describe, expect, it } from "vitest";
import {
  DOCUMENT_PREVIEW_DEFAULT_WIDTH,
  DOCUMENT_PREVIEW_MAX_WIDTH,
  DOCUMENT_PREVIEW_MIN_WIDTH,
  clampDocumentPreviewWidth,
} from "./DocumentPreviewPane";

describe("clampDocumentPreviewWidth", () => {
  it("keeps the preview pane within its desktop resize limits", () => {
    expect(clampDocumentPreviewWidth(120)).toBe(DOCUMENT_PREVIEW_MIN_WIDTH);
    expect(clampDocumentPreviewWidth(1200)).toBe(DOCUMENT_PREVIEW_MAX_WIDTH);
    expect(clampDocumentPreviewWidth(640)).toBe(640);
  });

  it("preserves room for the main message pane on narrower viewports", () => {
    expect(clampDocumentPreviewWidth(900, 820)).toBe(460);
    expect(clampDocumentPreviewWidth(900, 680)).toBe(DOCUMENT_PREVIEW_MIN_WIDTH);
  });

  it("falls back to the default width for non-finite input", () => {
    expect(clampDocumentPreviewWidth(Number.NaN)).toBe(DOCUMENT_PREVIEW_DEFAULT_WIDTH);
    expect(clampDocumentPreviewWidth(Number.POSITIVE_INFINITY)).toBe(DOCUMENT_PREVIEW_DEFAULT_WIDTH);
  });
});
