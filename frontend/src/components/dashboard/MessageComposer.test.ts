import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MessageComposer, {
  getClipboardFiles,
  isImeComposing,
  MESSAGE_COMPOSER_TEXTAREA_AUTOCOMPLETE,
  MESSAGE_COMPOSER_TEXTAREA_ID_PREFIX,
  MESSAGE_COMPOSER_TEXTAREA_NAME,
  textHasMention,
} from "./MessageComposer";

describe("message composer autofill metadata", () => {
  it("uses neutral field identifiers so password managers do not infer credentials", () => {
    const identifiers = `${MESSAGE_COMPOSER_TEXTAREA_ID_PREFIX} ${MESSAGE_COMPOSER_TEXTAREA_NAME}`;

    expect(identifiers).not.toMatch(/pass(word)?|passwd|token|secret|credential|auth|login/i);
    expect(MESSAGE_COMPOSER_TEXTAREA_AUTOCOMPLETE).toBe("off");
  });

  it("applies autofill suppression metadata to the rendered textarea", () => {
    const markup = renderToStaticMarkup(React.createElement(MessageComposer, { onSend: () => undefined }));
    const textarea = markup.match(/<textarea\b[^>]*>/)?.[0] ?? "";
    const getAttribute = (name: string) => textarea.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

    expect(textarea).not.toBe("");
    expect(getAttribute("id")).toMatch(new RegExp(`^${MESSAGE_COMPOSER_TEXTAREA_ID_PREFIX}-`));
    expect(getAttribute("name")).toBe(MESSAGE_COMPOSER_TEXTAREA_NAME);
    expect(getAttribute("autoComplete")).toBe("off");
    expect(getAttribute("data-form-type")).toBe("other");
    expect(getAttribute("inputMode")).toBe("text");
    expect(getAttribute("autoCapitalize")).toBe("sentences");
    expect(getAttribute("autoCorrect")).toBe("on");
    expect(getAttribute("spellCheck")).toBe("true");
  });
});

describe("textHasMention", () => {
  it("keeps structured @Name(agentId) mentions active", () => {
    expect(textHasMention("@Harry(ag_973dfb9193eb) 今天的AI日报发一下呢", "Harry")).toBe(true);
  });

  it("does not match a display name prefix inside a longer name", () => {
    expect(textHasMention("@HarryPotter please reply", "Harry")).toBe(false);
  });
});

describe("isImeComposing", () => {
  it("treats explicit composition state as active", () => {
    expect(isImeComposing({ isComposing: false }, true)).toBe(true);
  });

  it("honors the browser composition flag", () => {
    expect(isImeComposing({ isComposing: true }, false)).toBe(true);
  });

  it("handles IME process key events reported with keyCode 229", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 229 }, false)).toBe(true);
  });

  it("returns false for regular key events outside composition", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 13 }, false)).toBe(false);
  });
});

describe("getClipboardFiles", () => {
  it("uses clipboard files when the browser exposes them directly", () => {
    const image = { name: "screenshot.png", type: "image/png" } as File;
    const text = { name: "notes.txt", type: "text/plain" } as File;

    expect(getClipboardFiles({
      files: [image, text] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
    })).toEqual([image, text]);
  });

  it("falls back to file items for pasted screenshots", () => {
    const image = { name: "image.png", type: "image/png" } as File;

    expect(getClipboardFiles({
      files: [] as unknown as FileList,
      items: [
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => image },
      ] as unknown as DataTransferItemList,
    })).toEqual([image]);
  });
});
