import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportAgentCredentials, registerAgent } from "../commands/register.js";
import { derivePublicKey, generateKeypair } from "../crypto.js";
import { setBotCordRuntime } from "../runtime.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createFetchResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("registerAgent", () => {
  it("writes credentials to a file and stores only the file reference in config", async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "botcord-register-test-"));
    tempDirs.push(tempHome);
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    const writeConfigFile = vi.fn().mockResolvedValue(undefined);
    setBotCordRuntime({ config: { writeConfigFile } } as any);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createFetchResponse(201, {
        agent_id: "ag_test123456",
        key_id: "k_test123456",
        challenge: Buffer.from("challenge-1").toString("base64"),
      }))
      .mockResolvedValueOnce(createFetchResponse(200, {
        agent_token: "jwt-token",
        expires_at: 1234567890,
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await registerAgent({
      name: "test-agent",
      bio: "",
      hub: "https://hub.test",
      config: { channels: { botcord: { deliveryMode: "polling" } } },
    });

    const savedCredentials = JSON.parse(readFileSync(result.credentialsFile, "utf8")) as Record<string, string>;
    expect(savedCredentials.agentId).toBe("ag_test123456");
    expect(savedCredentials.keyId).toBe("k_test123456");
    expect(savedCredentials.hubUrl).toBe("https://hub.test");
    expect(savedCredentials.privateKey).toBeTruthy();
    expect(savedCredentials.publicKey).toBeTruthy();

    const writtenConfig = writeConfigFile.mock.calls[0][0];
    expect(writtenConfig.channels.botcord.credentialsFile).toBe(result.credentialsFile);
    expect(writtenConfig.channels.botcord.deliveryMode).toBe("polling");
    expect("privateKey" in writtenConfig.channels.botcord).toBe(false);
    expect("publicKey" in writtenConfig.channels.botcord).toBe(false);
    expect("agentId" in writtenConfig.channels.botcord).toBe(false);
    expect("keyId" in writtenConfig.channels.botcord).toBe(false);
    expect("hubUrl" in writtenConfig.channels.botcord).toBe(false);
  });

  it("reuses the existing private key unless newIdentity is requested", async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "botcord-register-test-"));
    tempDirs.push(tempHome);
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    const existing = generateKeypair();
    const writeConfigFile = vi.fn().mockResolvedValue(undefined);
    setBotCordRuntime({ config: { writeConfigFile } } as any);

    const fetchMock = vi.fn()
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { pubkey: string };
        expect(body.pubkey).toBe(`ed25519:${existing.publicKey}`);
        return createFetchResponse(201, {
          agent_id: "ag_reused1234",
          key_id: "k_reused1234",
          challenge: Buffer.from("challenge-2").toString("base64"),
        });
      })
      .mockResolvedValueOnce(createFetchResponse(200, {
        agent_token: "jwt-token",
        expires_at: 1234567890,
      }));
    vi.stubGlobal("fetch", fetchMock);

    await registerAgent({
      name: "existing-agent",
      bio: "existing bio",
      hub: "https://hub.test",
      config: {
        channels: {
          botcord: {
            agentId: "ag_existing",
            keyId: "k_existing",
            privateKey: existing.privateKey,
            publicKey: existing.publicKey,
          },
        },
      },
    });

    const writtenConfig = writeConfigFile.mock.calls[0][0];
    const savedCredentials = JSON.parse(
      readFileSync(writtenConfig.channels.botcord.credentialsFile, "utf8"),
    ) as Record<string, string>;
    expect(savedCredentials.privateKey).toBe(existing.privateKey);
    expect(savedCredentials.publicKey).toBe(existing.publicKey);
  });

  it("fails fast when credentialsFile is configured but unreadable", async () => {
    const writeConfigFile = vi.fn().mockResolvedValue(undefined);
    setBotCordRuntime({ config: { writeConfigFile } } as any);
    vi.stubGlobal("fetch", vi.fn());

    await expect(registerAgent({
      name: "broken-agent",
      bio: "broken bio",
      hub: "https://hub.test",
      config: {
        channels: {
          botcord: {
            credentialsFile: "/path/does/not/exist.json",
          },
        },
      },
    })).rejects.toThrow("credentialsFile is configured but could not be loaded");

    expect(writeConfigFile).not.toHaveBeenCalled();
  });
});

describe("exportAgentCredentials", () => {
  it("exports the managed credentials file to a new destination", async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "botcord-export-test-"));
    tempDirs.push(tempHome);

    const keys = generateKeypair();
    const sourceFile = path.join(tempHome, "managed.json");
    const destinationFile = path.join(tempHome, "exports", "agent.json");
    writeFileSync(sourceFile, JSON.stringify({
      version: 1,
      hubUrl: "https://hub.test",
      agentId: "ag_export123",
      keyId: "k_export123",
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      displayName: "export-agent",
      savedAt: "2026-03-18T00:00:00.000Z",
    }, null, 2));

    const result = await exportAgentCredentials({
      config: {
        channels: {
          botcord: {
            credentialsFile: sourceFile,
          },
        },
      },
      destinationFile,
    });

    const exportedCredentials = JSON.parse(readFileSync(destinationFile, "utf8")) as Record<string, string>;
    expect(result.sourceFile).toBe(sourceFile);
    expect(result.credentialsFile).toBe(destinationFile);
    expect(exportedCredentials.agentId).toBe("ag_export123");
    expect(exportedCredentials.keyId).toBe("k_export123");
    expect(exportedCredentials.hubUrl).toBe("https://hub.test");
    expect(exportedCredentials.privateKey).toBe(keys.privateKey);
    expect(exportedCredentials.publicKey).toBe(keys.publicKey);
    expect(exportedCredentials.displayName).toBe("export-agent");
    expect(exportedCredentials.savedAt).not.toBe("2026-03-18T00:00:00.000Z");
  });

  it("exports managed credentials from an account-mapped config", async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "botcord-export-test-"));
    tempDirs.push(tempHome);

    const keys = generateKeypair();
    const sourceFile = path.join(tempHome, "mapped.json");
    const destinationFile = path.join(tempHome, "exports", "mapped-agent.json");
    writeFileSync(sourceFile, JSON.stringify({
      version: 1,
      hubUrl: "https://hub.test",
      agentId: "ag_mapped123",
      keyId: "k_mapped123",
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      displayName: "mapped-agent",
      savedAt: "2026-03-18T00:00:00.000Z",
    }, null, 2));

    const result = await exportAgentCredentials({
      config: {
        channels: {
          botcord: {
            accounts: {
              prod: {
                credentialsFile: sourceFile,
              },
            },
          },
        },
      },
      destinationFile,
    });

    const exportedCredentials = JSON.parse(readFileSync(destinationFile, "utf8")) as Record<string, string>;
    expect(result.sourceFile).toBe(sourceFile);
    expect(exportedCredentials.displayName).toBe("mapped-agent");
    expect(exportedCredentials.agentId).toBe("ag_mapped123");
  });

  it("exports inline credentials and re-derives the public key", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "botcord-export-test-"));
    tempDirs.push(tempDir);

    const keys = generateKeypair();
    const staleKeys = generateKeypair();
    const destinationFile = path.join(tempDir, "inline.json");

    await exportAgentCredentials({
      config: {
        channels: {
          botcord: {
            hubUrl: "https://hub.test",
            agentId: "ag_inline123",
            keyId: "k_inline123",
            privateKey: keys.privateKey,
            publicKey: staleKeys.publicKey,
          },
        },
      },
      destinationFile,
    });

    const exportedCredentials = JSON.parse(readFileSync(destinationFile, "utf8")) as Record<string, string>;
    expect(exportedCredentials.publicKey).toBe(derivePublicKey(keys.privateKey));
    expect(exportedCredentials.publicKey).not.toBe(staleKeys.publicKey);
    expect(exportedCredentials.agentId).toBe("ag_inline123");
    expect(exportedCredentials.keyId).toBe("k_inline123");
  });

  it("refuses to overwrite an existing destination file unless force is enabled", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "botcord-export-test-"));
    tempDirs.push(tempDir);

    const keys = generateKeypair();
    const destinationFile = path.join(tempDir, "existing.json");
    writeFileSync(destinationFile, JSON.stringify({ preserved: true }, null, 2));

    await expect(exportAgentCredentials({
      config: {
        channels: {
          botcord: {
            hubUrl: "https://hub.test",
            agentId: "ag_force123",
            keyId: "k_force123",
            privateKey: keys.privateKey,
          },
        },
      },
      destinationFile,
    })).rejects.toThrow("Destination credentials file already exists");

    const preserved = JSON.parse(readFileSync(destinationFile, "utf8")) as Record<string, unknown>;
    expect(preserved.preserved).toBe(true);

    await exportAgentCredentials({
      config: {
        channels: {
          botcord: {
            hubUrl: "https://hub.test",
            agentId: "ag_force123",
            keyId: "k_force123",
            privateKey: keys.privateKey,
          },
        },
      },
      destinationFile,
      force: true,
    });

    const exportedCredentials = JSON.parse(readFileSync(destinationFile, "utf8")) as Record<string, string>;
    expect(exportedCredentials.agentId).toBe("ag_force123");
    expect(exportedCredentials.keyId).toBe("k_force123");
  });

  it("fails fast when credentialsFile is configured but unreadable", async () => {
    await expect(exportAgentCredentials({
      config: {
        channels: {
          botcord: {
            credentialsFile: "/path/does/not/exist.json",
          },
        },
      },
      destinationFile: "/tmp/export.json",
    })).rejects.toThrow("credentialsFile is configured but could not be loaded");
  });
});
