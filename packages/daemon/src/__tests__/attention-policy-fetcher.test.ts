import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeypair } from "@botcord/protocol-core";
import { createAttentionPolicyFetcher } from "../attention-policy-fetcher.js";

function writeCredentials(agentId: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "botcord-policy-"));
  const file = path.join(dir, `${agentId}.json`);
  const keys = generateKeypair();
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      hubUrl: "https://hub.test",
      agentId,
      keyId: "key_1",
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      savedAt: new Date().toISOString(),
      token: "jwt",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return file;
}

describe("createAttentionPolicyFetcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches effective room attention policy with agent credentials", async () => {
    const credentialsPath = writeCredentials("ag_policy");
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://hub.test/hub/attention-policy?room_id=rm_1",
      );
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer jwt",
      );
      return new Response(
        JSON.stringify({
          mode: "mention_only",
          keywords: [],
          allowedSenderIds: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const fetchPolicy = createAttentionPolicyFetcher({
      credentialPathByAgentId: new Map([["ag_policy", credentialsPath]]),
    });

    await expect(
      fetchPolicy({ agentId: "ag_policy", roomId: "rm_1" }),
    ).resolves.toEqual({
      mode: "mention_only",
      keywords: [],
      allowedSenderIds: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
