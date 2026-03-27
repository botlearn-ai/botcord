import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetCredential } from "../reset-credential.js";
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

describe("resetCredential", () => {
  it("writes replacement credentials and updates config", async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "botcord-reset-test-"));
    tempDirs.push(tempHome);
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    const writeConfigFile = vi.fn().mockResolvedValue(undefined);
    setBotCordRuntime({ config: { writeConfigFile } } as any);

    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse(200, {
        agent_id: "ag_reset123",
        display_name: "Reset Agent",
        key_id: "k_reset123",
        agent_token: "jwt-reset-token",
        expires_at: 2222222222,
        hub_url: "https://hub.test",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await resetCredential({
      config: { channels: { botcord: {} } },
      agentId: "ag_reset123",
      resetCodeOrTicket: "rc_test123",
      hubUrl: "https://hub.test",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hub.test/api/users/me/agents/reset-credential");
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body.agent_id).toBe("ag_reset123");
    expect(body.reset_code).toBe("rc_test123");
    expect(body.pubkey).toMatch(/^ed25519:/);

    const savedCredentials = JSON.parse(readFileSync(result.credentialsFile, "utf8")) as Record<string, string | number>;
    expect(savedCredentials.agentId).toBe("ag_reset123");
    expect(savedCredentials.keyId).toBe("k_reset123");
    expect(savedCredentials.hubUrl).toBe("https://hub.test");
    expect(savedCredentials.token).toBe("jwt-reset-token");
    expect(savedCredentials.tokenExpiresAt).toBe(2222222222);
    expect(typeof savedCredentials.privateKey).toBe("string");

    const writtenConfig = writeConfigFile.mock.calls[0][0];
    expect(writtenConfig.channels.botcord.credentialsFile).toBe(result.credentialsFile);
    expect("privateKey" in writtenConfig.channels.botcord).toBe(false);
  });

  it("surfaces API failures", async () => {
    setBotCordRuntime({ config: { writeConfigFile: vi.fn() } } as any);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      createFetchResponse(401, { detail: "Reset ticket already used" }),
    ));

    await expect(resetCredential({
      config: { channels: { botcord: {} } },
      agentId: "ag_reset123",
      resetCodeOrTicket: "rc_used",
      hubUrl: "https://hub.test",
    })).rejects.toThrow("Credential reset failed (401): Reset ticket already used");
  });
});
