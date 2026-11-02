import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { recoverableSend } from "../dist/send-recovery.js";

function setup(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "send-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, key: "test", prepare: async () => [{ url: "https://files.example/original" }] };
}
const missing = () => { throw Object.assign(new Error("not found"), { status: 404 }); };

test("accepted POST with lost response recovers without resending", async (t) => {
  const options = setup(t); let sends = 0;
  const result = await recoverableSend({ ...options,
    send: async () => { sends++; throw new Error("timeout"); },
    status: async (id) => ({ msg_id: id, state: "delivered" }),
  });
  assert.equal(result.recovered, true);
  await recoverableSend({ ...options, send: async () => { sends++; }, status: missing });
  assert.equal(sends, 1);
});

test("a new invocation reuses the pending ID and original attachments", async (t) => {
  const options = setup(t); let first; let uploads = 0;
  options.prepare = async () => { uploads++; return [{ url: "original" }]; };
  await assert.rejects(recoverableSend({ ...options,
    send: async (id) => { first = id; throw new Error("timeout"); }, status: missing,
  }), /saved/);
  await recoverableSend({ ...options, status: missing,
    send: async (id, attachments) => {
      assert.equal(id, first); assert.deepEqual(attachments, [{ url: "original" }]);
      return { queued: true };
    },
  });
  assert.equal(uploads, 1);
  assert.equal(readdirSync(options.directory).length, 0);
});

test("unavailable status fails closed instead of creating a duplicate", async (t) => {
  const options = setup(t); let sends = 0;
  const request = { ...options, send: async () => { sends++; throw new Error("timeout"); },
    status: async () => { throw new Error("offline"); } };
  await assert.rejects(recoverableSend(request), /remains unknown/);
  await assert.rejects(recoverableSend(request), /remains unknown/);
  assert.equal(sends, 1);
});

test("ordinary successful identical messages remain separate sends", async (t) => {
  const options = setup(t); const ids = [];
  const request = { ...options, send: async (id) => { ids.push(id); return { queued: true }; }, status: missing };
  await recoverableSend(request); await recoverableSend(request);
  assert.notEqual(ids[0], ids[1]);
});

test("concurrent identical invocations cannot both POST", async (t) => {
  const options = setup(t); let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const first = recoverableSend({ ...options, send: async () => { await waiting; return {}; }, status: missing });
  await assert.rejects(recoverableSend({ ...options, send: async () => { throw new Error("must not send"); }, status: missing }), /already in progress/);
  release(); await first;
});

test("explicit message ID is preserved and rejected requests are not reported as recovered", async (t) => {
  const options = setup(t);
  await assert.rejects(recoverableSend({ ...options, messageId: "explicit-id",
    send: async (id) => { assert.equal(id, "explicit-id"); throw Object.assign(new Error("forbidden"), { status: 403 }); },
    status: async () => { throw new Error("must not query"); },
  }), /forbidden/);
});
