import { Buffer } from "node:buffer";

/** Return the UTF-8 byte length of a string. */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Slice a string to at most `maxBytes` UTF-8 bytes without splitting a code
 * point. Used by runtime adapters whose safety caps are byte-oriented.
 */
export function sliceUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8ByteLength(text) <= maxBytes) return text;

  let used = 0;
  let out = "";
  for (const ch of text) {
    const n = utf8ByteLength(ch);
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}
