import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

/**
 * Per-gateway secret store. Mirrors the daemon's
 * `~/.botcord/daemon/gateways/<id>.json` (mode 0600) but lives under the
 * ingress process's own data directory. Provider secrets never appear in
 * the public storage (`IngressStore`) — the connection row only carries
 * an opaque `secretRef` and the adapter resolves through this store.
 */
export interface IngressSecretStore {
  load<T extends object = Record<string, unknown>>(secretRef: string): T | null;
  write(secretRef: string, body: object): void;
  delete(secretRef: string): void;
  rootDir(): string;
}

export class FileSecretStore implements IngressSecretStore {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolvePath(rootDir);
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
  }

  rootDir(): string {
    return this.root;
  }

  private path(secretRef: string): string {
    if (secretRef.includes("/") || secretRef.includes("..")) {
      throw new Error("invalid secret ref");
    }
    return join(this.root, `${secretRef}.json`);
  }

  load<T extends object = Record<string, unknown>>(secretRef: string): T | null {
    const path = this.path(secretRef);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return null;
    }
  }

  write(secretRef: string, body: object): void {
    const path = this.path(secretRef);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(body));
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // chmod is best-effort on platforms (Windows) that don't honor it.
    }
    renameSync(tmp, path);
  }

  delete(secretRef: string): void {
    const path = this.path(secretRef);
    if (existsSync(path)) unlinkSync(path);
  }
}

export class MemorySecretStore implements IngressSecretStore {
  private readonly map = new Map<string, object>();

  rootDir(): string {
    return "(memory)";
  }

  load<T extends object = Record<string, unknown>>(secretRef: string): T | null {
    const v = this.map.get(secretRef);
    return (v ?? null) as T | null;
  }

  write(secretRef: string, body: object): void {
    this.map.set(secretRef, body);
  }

  delete(secretRef: string): void {
    this.map.delete(secretRef);
  }
}
