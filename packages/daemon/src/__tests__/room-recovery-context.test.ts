import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BotCordClient,
  generateKeypair,
  resetSharedCredentialStatesForTests,
} from "@botcord/protocol-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecentRoomMessagesRecoveryBuilder } from "../room-recovery-context.js";

function writeCredentials(agentId: string): {
  credentialsPath: string;
  privateKey: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "botcord-recovery-context-"));
  const credentialsPath = path.join(dir, `${agentId}.json`);
  const keys = generateKeypair();
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      version: 1,
      hubUrl: "https://hub.test",
      agentId,
      keyId: "key_1",
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      savedAt: new Date().toISOString(),
      token: "stale-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return { credentialsPath, privateKey: keys.privateKey };
}

describe("createRecentRoomMessagesRecoveryBuilder", () => {
  beforeEach(() => {
    resetSharedCredentialStatesForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists a refresh initiated by the recovery client for a shared credential scope", async () => {
    const { credentialsPath, privateKey } = writeCredentials("ag_recovery");
    const peerClient = new BotCordClient({
      hubUrl: "https://hub.test",
      agentId: "ag_recovery",
      keyId: "key_1",
      privateKey,
      token: "stale-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const expiresAt = Math.floor(Date.now() / 1000) + 7200;
    const authorizations: string[] = [];
    let roomAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/registry/agents/ag_recovery/token/refresh")) {
          return Response.json({
            agent_token: "fresh-token",
            expires_at: expiresAt,
          });
        }
        if (url.endsWith("/hub/rooms/rm_1/messages?limit=20")) {
          authorizations.push(
            ((init?.headers ?? {}) as Record<string, string>).Authorization,
          );
          roomAttempts += 1;
          if (roomAttempts === 1) {
            return new Response("stale", { status: 401 });
          }
          return Response.json({ messages: [] });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const buildRecoveryContext = createRecentRoomMessagesRecoveryBuilder({
      credentialPathByAgentId: new Map([["ag_recovery", credentialsPath]]),
    });

    await expect(
      buildRecoveryContext({
        accountId: "ag_recovery",
        conversation: { id: "rm_1" },
      } as Parameters<typeof buildRecoveryContext>[0]),
    ).resolves.toBe("[Recent Room Messages]\n(none)");

    expect(authorizations).toEqual([
      "Bearer stale-token",
      "Bearer fresh-token",
    ]);
    expect(peerClient.getToken()).toBe("fresh-token");
    expect(JSON.parse(readFileSync(credentialsPath, "utf8"))).toMatchObject({
      token: "fresh-token",
      tokenExpiresAt: expiresAt,
    });
  });
});
