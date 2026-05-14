import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, release, arch } from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { deflateRawSync } from "node:zlib";
import {
  AUTH_EXPIRED_FLAG_PATH,
  USER_AUTH_PATH,
  type UserAuthManager,
  type UserAuthRecord,
} from "./user-auth.js";
import {
  CONFIG_FILE_PATH,
  PID_PATH,
  SNAPSHOT_PATH,
  loadConfig,
  saveConfig,
  type DaemonConfig,
} from "./config.js";
import { listDaemonLogFiles, LOG_FILE_PATH, type LogFileEntry } from "./log.js";
import { listAcpTraceLogFiles, listRuntimeLogFiles } from "./acp-logs.js";
import {
  channelsFromDaemonConfig,
  defaultHttpFetcher,
  renderDoctor,
  runDoctor,
  type DoctorFileReader,
  type DoctorRuntimeEntry,
} from "./doctor.js";
import { detectRuntimes } from "./adapters/runtimes.js";
import { log as daemonLog } from "./log.js";
import {
  discoverLocalOpenclawGateways,
  mergeOpenclawGateways,
  openclawDiscoveryConfigEnabled,
} from "./openclaw-discovery.js";

const DIAGNOSTICS_DIR = path.join(homedir(), ".botcord", "diagnostics");
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const DEFAULT_ROTATED_LOGS_IN_BUNDLE = 5;

export interface CreateDiagnosticBundleOptions {
  diagnosticsDir?: string;
  logFile?: string;
  configFile?: string;
  snapshotFile?: string;
  doctor?: { text: string; json: unknown };
  includeAllLogs?: boolean;
}

export interface DiagnosticBundleResult {
  path: string;
  filename: string;
  sizeBytes: number;
  createdAt: string;
  revealCommand: string;
  copyPathCommand: string;
}

export interface DiagnosticUploadResult {
  bundleId: string;
  filename: string;
  sizeBytes: number;
  expiresAt?: string;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(Authorization:\s*Bearer\s+)[^\s"']+/gi, "$1[REDACTED]"],
  [/("?(?:accessToken|access_token|refreshToken|refresh_token|token|privateKey|private_key|secret)"?\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2"],
  [/(drt_)[A-Za-z0-9_-]+/g, "$1[REDACTED]"],
  [/(dit_)[A-Za-z0-9_-]+/g, "$1[REDACTED]"],
  [/([?&](?:token|access_token|refresh_token|install_token)=)[^&\s"']+/gi, "$1[REDACTED]"],
];

function redact(input: string): string {
  let out = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function safeReadText(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return redact(readFileSync(file, "utf8"));
  } catch (err) {
    return `read failed: ${err instanceof Error ? err.message : String(err)}\n`;
  }
}

function readUserAuthSummary(): Record<string, unknown> | null {
  const raw = safeReadText(USER_AUTH_PATH);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      userId: typeof parsed.userId === "string" ? parsed.userId : null,
      daemonInstanceId:
        typeof parsed.daemonInstanceId === "string" ? parsed.daemonInstanceId : null,
      hubUrl: typeof parsed.hubUrl === "string" ? parsed.hubUrl : null,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : null,
      loggedInAt: typeof parsed.loggedInAt === "string" ? parsed.loggedInAt : null,
      label: typeof parsed.label === "string" ? parsed.label : null,
      authExpiredFlagPresent: existsSync(AUTH_EXPIRED_FLAG_PATH),
    };
  } catch (err) {
    return {
      error: `user-auth summary failed: ${err instanceof Error ? err.message : String(err)}`,
      authExpiredFlagPresent: existsSync(AUTH_EXPIRED_FLAG_PATH),
    };
  }
}

const fsFileReader: DoctorFileReader = {
  readFile(p: string): string | null {
    if (!existsSync(p)) return null;
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
};

async function buildDoctorEntries(): Promise<{
  text: string;
  json: unknown;
}> {
  const entries: DoctorRuntimeEntry[] = detectRuntimes();
  let channels: ReturnType<typeof channelsFromDaemonConfig> = [];
  let cfgForEndpoints: DaemonConfig | null = null;
  try {
    cfgForEndpoints = loadConfig();
    cfgForEndpoints = await refreshDiscoveredOpenclawGateways(cfgForEndpoints);
    channels = channelsFromDaemonConfig(cfgForEndpoints);
  } catch {
    channels = [];
  }
  if (cfgForEndpoints?.openclawGateways && cfgForEndpoints.openclawGateways.length > 0) {
    const { collectRuntimeSnapshotAsync } = await import("./provision.js");
    const snap = await collectRuntimeSnapshotAsync({ cfg: cfgForEndpoints });
    const byId = new Map(snap.runtimes.map((r) => [r.id, r]));
    for (const e of entries) {
      const r = byId.get(e.id);
      if (r?.endpoints) e.endpoints = r.endpoints;
    }
  }
  const input = await runDoctor(entries, channels, {
    credentialsPath: (accountId) =>
      path.join(homedir(), ".botcord", "credentials", `${accountId}.json`),
    fileReader: fsFileReader,
    fetcher: defaultHttpFetcher,
    timeoutMs: 5_000,
  });
  return { text: renderDoctor(input), json: input };
}

async function refreshDiscoveredOpenclawGateways(cfg: DaemonConfig): Promise<DaemonConfig> {
  if (!openclawDiscoveryConfigEnabled(cfg)) return cfg;
  try {
    const found = await discoverLocalOpenclawGateways({
      searchPaths: cfg.openclawDiscovery?.searchPaths,
      defaultPorts: cfg.openclawDiscovery?.defaultPorts,
      timeoutMs: 500,
    });
    const merged = mergeOpenclawGateways(cfg, found);
    if (!merged.changed) return cfg;
    saveConfig(merged.cfg);
    daemonLog.info("openclaw discovery: gateways merged", {
      source: "diagnostics",
      added: merged.added.map((g) => ({ name: g.name, url: g.url })),
    });
    return merged.cfg;
  } catch (err) {
    daemonLog.warn("openclaw discovery failed; continuing", {
      source: "diagnostics",
      error: err instanceof Error ? err.message : String(err),
    });
    return cfg;
  }
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function createZip(entries: Array<{ name: string; data: string | Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dt = dosDateTime(now);

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/^\/+/, ""), "utf8");
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(8),
      u16(dt.time),
      u16(dt.date),
      u32(crc),
      u32(compressed.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      compressed,
    ]);
    localParts.push(local);

    centralParts.push(Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(8),
      u16(dt.time),
      u16(dt.date),
      u32(crc),
      u32(compressed.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]));
    offset += local.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...localParts, central, end]);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function diagnosticBundleCommands(filePath: string): {
  revealCommand: string;
  copyPathCommand: string;
} {
  if (process.platform === "darwin") {
    return {
      revealCommand: `open -R ${shellQuote(filePath)}`,
      copyPathCommand: `printf '%s' ${shellQuote(filePath)} | pbcopy`,
    };
  }

  if (process.platform === "win32") {
    const psPath = filePath.replace(/'/g, "''");
    return {
      revealCommand: `explorer.exe /select,"${filePath.replace(/"/g, '""')}"`,
      copyPathCommand: `powershell.exe -NoProfile -Command "Set-Clipboard -Value '${psPath}'"`,
    };
  }

  return {
    revealCommand: `xdg-open ${shellQuote(path.dirname(filePath))}`,
    copyPathCommand: `printf '%s' ${shellQuote(filePath)} | xclip -selection clipboard`,
  };
}

function bundledLogs(logFile: string, includeAllLogs: boolean): LogFileEntry[] {
  const all = listDaemonLogFiles(logFile);
  const active = all.filter((entry) => entry.active);
  const rotated = all.filter((entry) => !entry.active);
  return [
    ...active,
    ...(includeAllLogs ? rotated : rotated.slice(0, DEFAULT_ROTATED_LOGS_IN_BUNDLE)),
  ];
}

export async function createDiagnosticBundle(
  opts: CreateDiagnosticBundleOptions = {},
): Promise<DiagnosticBundleResult> {
  const createdAt = new Date();
  const stamp = createdAt.toISOString().replace(/[:.]/g, "-");
  const filename = `botcord-daemon-diagnostics-${stamp}.zip`;
  const diagnosticsDir = opts.diagnosticsDir ?? DIAGNOSTICS_DIR;
  const logFile = opts.logFile ?? LOG_FILE_PATH;
  const configFile = opts.configFile ?? CONFIG_FILE_PATH;
  const snapshotFile = opts.snapshotFile ?? SNAPSHOT_PATH;
  const includeAllLogs = opts.includeAllLogs === true;
  const logs = bundledLogs(logFile, includeAllLogs);
  const acpLogs = listAcpTraceLogFiles(includeAllLogs);
  const runtimeLogs = listRuntimeLogFiles(includeAllLogs);
  mkdirSync(diagnosticsDir, { recursive: true, mode: 0o700 });

  const doctor = opts.doctor ?? await buildDoctorEntries();
  const status = {
    createdAt: createdAt.toISOString(),
    host: hostname(),
    platform: platform(),
    release: release(),
    arch: arch(),
    node: process.version,
    pidPath: PID_PATH,
    pid: process.pid,
    configPath: configFile,
    snapshotPath: snapshotFile,
    logPath: logFile,
    logsBundled: logs.map((entry) => ({
      name: entry.name,
      path: entry.path,
      sizeBytes: entry.sizeBytes,
      active: entry.active,
    })),
    acpLogsBundled: acpLogs.map((entry) => ({
      name: entry.name,
      path: entry.path,
      sizeBytes: entry.sizeBytes,
    })),
    runtimeLogsBundled: runtimeLogs.map((entry) => ({
      name: entry.bundleName,
      path: entry.path,
      sizeBytes: entry.sizeBytes,
    })),
    logsBundleMode: includeAllLogs ? "all" : `active_plus_${DEFAULT_ROTATED_LOGS_IN_BUNDLE}_rotated`,
    diagnosticsDir,
    userAuth: readUserAuthSummary(),
  };

  const entries: Array<{ name: string; data: string | Buffer }> = [
    { name: "README.txt", data: "BotCord daemon diagnostics bundle. Sensitive tokens are redacted before packaging.\n" },
    { name: "status.json", data: JSON.stringify(status, null, 2) + "\n" },
    { name: "doctor.txt", data: doctor.text + "\n" },
    { name: "doctor.json", data: JSON.stringify(doctor.json, null, 2) + "\n" },
  ];
  if (logs.length === 0) {
    entries.push({
      name: "daemon.log",
      data: `no log file at ${logFile}\n`,
    });
  } else {
    for (const entry of logs) {
      const log = safeReadText(entry.path);
      entries.push({
        name: entry.active ? "daemon.log" : `logs/${entry.name}`,
        data: log ?? `no log file at ${entry.path}\n`,
      });
    }
  }
  for (const entry of acpLogs) {
    const log = safeReadText(entry.path);
    entries.push({
      name: `acp-logs/${entry.name.split(path.sep).join("/")}`,
      data: log ?? `no ACP log file at ${entry.path}\n`,
    });
  }
  for (const entry of runtimeLogs) {
    const log = safeReadText(entry.path);
    entries.push({
      name: entry.bundleName,
      data: log ?? `no runtime log file at ${entry.path}\n`,
    });
  }
  const config = safeReadText(configFile);
  entries.push({
    name: "config.json.redacted",
    data: config ?? `no config file at ${configFile}\n`,
  });
  const snapshot = safeReadText(snapshotFile);
  entries.push({
    name: "snapshot.json",
    data: snapshot ?? `no snapshot file at ${snapshotFile}\n`,
  });

  const zip = createZip(entries);
  const out = path.join(diagnosticsDir, filename);
  writeFileSync(out, zip, { mode: 0o600 });
  const commands = diagnosticBundleCommands(out);
  return {
    path: out,
    filename,
    sizeBytes: zip.length,
    createdAt: createdAt.toISOString(),
    ...commands,
  };
}

export async function uploadDiagnosticBundle(opts: {
  auth: UserAuthManager;
  bundle: DiagnosticBundleResult;
}): Promise<DiagnosticUploadResult> {
  const record: UserAuthRecord | null = opts.auth.current;
  if (!record) throw new Error("daemon not logged in");
  const data = readFileSync(opts.bundle.path);
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new Error(`diagnostic bundle is too large (${data.length} bytes, max ${MAX_UPLOAD_BYTES})`);
  }
  const token = await opts.auth.ensureAccessToken();
  const url = `${record.hubUrl.replace(/\/+$/, "")}/daemon/diagnostics/upload`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/zip",
      "X-BotCord-Filename": opts.bundle.filename,
    },
    body: data,
  });
  const json = await resp.json().catch(() => null) as Record<string, unknown> | null;
  if (!resp.ok) {
    const detail =
      typeof json?.detail === "string"
        ? json.detail
        : typeof json?.error === "string"
          ? json.error
          : `HTTP ${resp.status}`;
    throw new Error(`diagnostic upload failed: ${detail}`);
  }
  const bundleId = typeof json?.bundle_id === "string" ? json.bundle_id : null;
  if (!bundleId) throw new Error("diagnostic upload response missing bundle_id");
  return {
    bundleId,
    filename: typeof json?.filename === "string" ? json.filename : opts.bundle.filename,
    sizeBytes: typeof json?.size_bytes === "number" ? json.size_bytes : data.length,
    ...(typeof json?.expires_at === "string" ? { expiresAt: json.expires_at } : {}),
  };
}

export { DIAGNOSTICS_DIR };
