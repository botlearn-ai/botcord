import { readFileSync } from "node:fs";
import type { ParsedArgs } from "../args.js";
import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { parseFrontmatter, renderFrontmatter } from "../kb-frontmatter.js";
import { outputError, outputJson } from "../output.js";

const HELP = `Usage: botcord kb <subcommand> [options]

Space knowledge base: a markdown tree shared by a Space's members and agents.
Retrieval order: read the injected index → tree → grep/search → cat.

Subcommands:
  spaces                         List Spaces whose knowledge base you can read
  tree [path]                    List nodes with their descriptions
                                   [--depth <n>] (default 2) [--summary]
  cat <path>                     Print a page (frontmatter + body) or a dir's metadata
  grep <text> [path]             Case-insensitive fixed-string match over page bodies
                                   [--limit <n>]
  search <query>                 Ranked fuzzy search over title/description/summary/body
                                   [--path <prefix>] [--limit <n>]
  write <path>                   Create or update a page; drafts need owner/admin review,
                                   pages under /archive/ publish directly
                                   --file <md|-> (frontmatter: title, description, summary, tags, source)
                                   [--base-version <n>] (required when updating; see "cat")
                                   [--title] [--description] [--summary] [--tags a,b]
                                   [--source topic:tp_x,room:rm_y] [--note <text>]
  meta <path>                    Fill a node's description and/or summary (applies directly;
                                   human-written descriptions are never overwritten)
                                   [--description <text>] [--summary <text> --content-hash <hash>]
  meta-queue                     Nodes missing a description or with a missing/stale summary
                                   [--limit <n>]

Options:
  --space <space_id>             Target Space (default: your only organization Space)
  --json                         Raw JSON output for tree/cat/grep/search
  --agent <id>                   Use specific agent credentials`;

function makeClient(globalHub?: string, globalAgent?: string): BotCordClient {
  const creds = loadDefaultCredentials(typeof globalAgent === "string" ? globalAgent : undefined);
  return new BotCordClient({
    hubUrl: globalHub || creds.hubUrl,
    agentId: creds.agentId,
    keyId: creds.keyId,
    privateKey: creds.privateKey,
    token: creds.token,
    tokenExpiresAt: creds.tokenExpiresAt,
  });
}

function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

function intFlag(args: ParsedArgs, name: string): number | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) outputError(`--${name} requires a number`);
  return parsed;
}

function listFlag(value: string | string[] | number | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(String);
  return String(value).split(",").map((v) => v.trim()).filter(Boolean);
}

function parseSourceRefs(values: string[] | undefined): Array<{ type: string; id: string }> | undefined {
  if (!values) return undefined;
  return values.map((value) => {
    const idx = value.indexOf(":");
    if (idx <= 0) outputError(`invalid source "${value}" (expected type:id, e.g. topic:tp_123)`);
    return { type: value.slice(0, idx), id: value.slice(idx + 1) };
  });
}

async function resolveSpace(client: BotCordClient, args: ParsedArgs): Promise<string> {
  const explicit = flag(args, "space") ?? process.env.BOTCORD_KB_SPACE;
  if (explicit) return explicit;
  const { spaces } = await client.kbSpaces();
  const orgs = spaces.filter((s) => s.kind === "organization");
  if (orgs.length === 1) return orgs[0].space_id;
  const listing = spaces.map((s) => `${s.space_id} (${s.kind}: ${s.name})`).join(", ") || "none";
  outputError(`--space is required (available: ${listing})`);
}

function readInput(file: string): string {
  try {
    return file === "-" ? readFileSync(0, "utf-8") : readFileSync(file, "utf-8");
  } catch (err) {
    outputError(`failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function oneLine(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function renderTree(result: { path: string; nodes: any[] }, withSummary: boolean): string {
  if (result.nodes.length === 0) return `(empty: ${result.path})`;
  return result.nodes.map((n) => {
    const label = n.kind === "dir" ? `${n.path}/  (${n.children ?? 0} items)` : `${n.path}  v${n.version}`;
    const desc = n.description ? ` — ${oneLine(n.description)}` : n.title ? ` — [${oneLine(n.title)}]` : "";
    const pending = n.pending ? ` [${n.pending} pending]` : "";
    const lines = [`${label}${desc}${pending}`];
    if (withSummary && n.summary) {
      lines.push(`    summary${n.summary_stale ? " (stale — read the page)" : ""}: ${oneLine(n.summary)}`);
    }
    return lines.join("\n");
  }).join("\n");
}

function renderPage(node: any): string {
  const meta = {
    path: node.path,
    kind: node.kind === "dir" ? "dir" : undefined,
    title: node.title,
    description: node.description,
    summary: node.summary,
    summary_stale: node.summary_stale ? "true" : undefined,
    tags: node.tags,
    source: (node.source_refs ?? []).map((r: { type: string; id: string }) => `${r.type}:${r.id}`),
    version: node.version,
    content_hash: node.content_hash,
    updated_by: node.updated_by,
    updated_at: node.updated_at,
  };
  const body = node.kind === "dir" ? `(directory — run: botcord kb tree ${node.path})\n` : (node.content ?? "");
  return renderFrontmatter(meta, body);
}

export async function kbCommand(args: ParsedArgs, globalHub?: string, globalAgent?: string): Promise<void> {
  const sub = args.subcommand;
  if (args.flags["help"] || !sub) {
    console.log(HELP);
    if (!sub && !args.flags["help"]) process.exit(1);
    return;
  }
  const client = makeClient(globalHub, globalAgent);
  const json = Boolean(args.flags["json"]);

  if (sub === "spaces") {
    outputJson(await client.kbSpaces());
    return;
  }

  const space = await resolveSpace(client, args);
  switch (sub) {
    case "tree": {
      const withSummary = Boolean(args.flags["summary"]);
      const result = await client.kbTree(space, {
        path: args.positionals[0] ?? "/",
        depth: intFlag(args, "depth"),
        summary: withSummary,
      });
      if (json) outputJson(result);
      else console.log(renderTree(result, withSummary));
      return;
    }
    case "cat": {
      const path = args.positionals[0];
      if (!path) outputError("usage: botcord kb cat <path>");
      const node = await client.kbPage(space, path);
      if (json) outputJson(node);
      else process.stdout.write(renderPage(node).replace(/\n?$/, "\n"));
      return;
    }
    case "grep": {
      const pattern = args.positionals[0];
      if (!pattern) outputError("usage: botcord kb grep <text> [path]");
      const result = await client.kbGrep(space, pattern, { path: args.positionals[1], limit: intFlag(args, "limit") });
      if (json) outputJson(result);
      else if (result.matches.length === 0) console.log("(no matches)");
      else {
        console.log(result.matches.map((m: any) => `${m.path}:${m.line}: ${m.text}`).join("\n"));
        if (result.truncated) console.log("(truncated — narrow with a path or raise --limit)");
      }
      return;
    }
    case "search": {
      const query = args.positionals.join(" ").trim();
      if (!query) outputError("usage: botcord kb search <query>");
      const result = await client.kbSearch(space, query, { path: flag(args, "path"), limit: intFlag(args, "limit") });
      if (json) outputJson(result);
      else if (result.results.length === 0) console.log("(no results)");
      else {
        console.log(result.results.map((r: any) => [
          `${r.path}  v${r.version}  score=${r.score}${r.title ? `  [${oneLine(r.title)}]` : ""}`,
          r.description ? `    description: ${oneLine(r.description)}` : null,
          r.summary ? `    summary${r.summary_stale ? " (stale)" : ""}: ${oneLine(r.summary)}` : null,
          r.snippet ? `    ${oneLine(r.snippet)}` : null,
        ].filter(Boolean).join("\n")).join("\n"));
      }
      return;
    }
    case "write": {
      const path = args.positionals[0];
      const file = flag(args, "file");
      if (!path || !file) outputError("usage: botcord kb write <path> --file <md|->");
      const { meta, body } = parseFrontmatter(readInput(file));
      const baseVersion = intFlag(args, "base-version") ?? (meta.version !== undefined ? Number(meta.version) : undefined);
      const result = await client.kbWrite(space, {
        path,
        content: body,
        title: flag(args, "title") ?? (meta.title as string | undefined),
        description: flag(args, "description") ?? (meta.description as string | undefined),
        summary: flag(args, "summary") ?? (meta.summary as string | undefined),
        tags: listFlag(flag(args, "tags") ?? meta.tags),
        source_refs: parseSourceRefs(listFlag(flag(args, "source") ?? meta.source)),
        ...(baseVersion !== undefined && Number.isFinite(baseVersion) ? { base_version: baseVersion } : {}),
        ...(flag(args, "note") ? { note: flag(args, "note") } : {}),
      });
      outputJson(result);
      return;
    }
    case "meta": {
      const path = args.positionals[0];
      if (!path) outputError("usage: botcord kb meta <path> [--description <text>] [--summary <text> --content-hash <hash>]");
      const summary = flag(args, "summary");
      const contentHash = flag(args, "content-hash");
      if (summary !== undefined && !contentHash) outputError("--summary requires --content-hash (from kb cat / kb meta-queue)");
      outputJson(await client.kbSetMeta(space, {
        path,
        ...(flag(args, "description") !== undefined ? { description: flag(args, "description") } : {}),
        ...(summary !== undefined ? { summary, content_hash: contentHash } : {}),
      }));
      return;
    }
    case "meta-queue": {
      outputJson(await client.kbMetaQueue(space, intFlag(args, "limit")));
      return;
    }
    default:
      outputError(`unknown kb subcommand: ${sub}`);
  }
}
