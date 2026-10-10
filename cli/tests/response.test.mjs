import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "../dist/args.js";
import { responseCommand } from "../dist/commands/response.js";
import { sendCommand } from "../dist/commands/send.js";
import { defaultCredentialsFile, writeCredentialsFile } from "@botcord/protocol-core";

test("CLI reports selected decisions and signs an explicitly associated reply", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "botcord-response-cli-"));
  t.mock.method(os, "homedir", () => tempDir);
  t.mock.method(console, "log", () => {});
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({ run_id: "run1", status: "running", queued: true });
  });
  writeCredentialsFile(defaultCredentialsFile("ag_response_test"), {
    version: 1, hubUrl: "https://hub.example", agentId: "ag_response_test", keyId: "test-key",
    privateKey: Buffer.alloc(32, 7).toString("base64"), savedAt: new Date().toISOString(),
    token: "test-token", tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  try {
    for (const action of ["start", "no-reply"]) {
      await responseCommand(parseArgs(["response", action, "--run-id", "run1", "--room", "rm_test", "--messages", "m1,m2"]), undefined, "ag_response_test");
    }
    await sendCommand(parseArgs(["send", "--to", "rm_test", "--run-id", "run1", "--responds-to", "m1,m2", "--response-kind", "final", "--message-id", "stable-id", "--text", "answer"]), undefined, "ag_response_test");
    assert.equal(requests[0].body.action, "start");
    assert.equal(requests[1].body.action, "no_reply");
    assert.deepEqual(requests[1].body.message_ids, ["m1", "m2"]);
    assert.equal(requests[2].body.msg_id, "stable-id");
    assert.deepEqual(requests[2].body.payload.response, { run_id: "run1", responds_to: ["m1", "m2"], kind: "final" });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
