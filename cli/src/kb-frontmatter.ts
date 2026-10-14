// Minimal YAML-ish frontmatter for knowledge-base pages.
// Supports `key: value`, quoted strings, inline lists `[a, b]`, and block lists (`- item`).
// Rendering JSON-quotes any string that is not plainly safe, which stays valid YAML.

export type Frontmatter = Record<string, string | string[] | number>;

const FENCE = "---";

function parseScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function parseInlineList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1);
  if (!inner.trim()) return [];
  return inner.split(",").map((item) => parseScalar(item)).filter(Boolean);
}

/** Split `---` frontmatter from the body. Without a fence, the whole text is the body. */
export function parseFrontmatter(text: string): { meta: Frontmatter; body: string } {
  const normalized = text.replace(/^﻿/, "");
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) return { meta: {}, body: normalized };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === FENCE);
  if (end === -1) return { meta: {}, body: normalized };

  const meta: Frontmatter = {};
  let listKey: string | null = null;
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (meta[listKey] as string[]).push(parseScalar(item[1]));
      continue;
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, rest] = pair;
    if (!rest.trim()) {
      meta[key] = [];
      listKey = key;
    } else if (rest.trim().startsWith("[") && rest.trim().endsWith("]")) {
      meta[key] = parseInlineList(rest);
      listKey = null;
    } else {
      meta[key] = parseScalar(rest);
      listKey = null;
    }
  }
  const body = lines.slice(end + 1).join("\n").replace(/^\n/, "");
  return { meta, body };
}

function renderScalar(value: string | number): string {
  if (typeof value === "number") return String(value);
  return /^[\p{L}\p{N}_./@+-][\p{L}\p{N}\s_./@+()（），。、-]*$/u.test(value) && !/\s$/.test(value)
    ? value
    : JSON.stringify(value);
}

/** Render frontmatter + body. Undefined/null/empty values are skipped. */
export function renderFrontmatter(
  meta: Record<string, string | string[] | number | null | undefined>,
  body: string,
): string {
  const lines = [FENCE];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`, ...value.map((v) => `  - ${renderScalar(v)}`));
    } else {
      lines.push(`${key}: ${renderScalar(value)}`);
    }
  }
  lines.push(FENCE);
  return `${lines.join("\n")}\n${body}`;
}
