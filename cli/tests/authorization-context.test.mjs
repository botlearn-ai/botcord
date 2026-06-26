import assert from "node:assert/strict";
import test from "node:test";

import {
  addAuthorizationContextToDetail,
  addAuthorizationContextToUrl,
} from "../dist/authorization-context.js";

const credentials = {
  version: 1,
  hubUrl: "https://www.botcord.chat",
  agentId: "ag_test",
  keyId: "k_test",
  privateKey: "private",
  publicKey: "public",
  displayName: "Work laptop CLI",
  savedAt: "2026-06-25T00:00:00.000Z",
};

test("authorization context adds local credential hints to management links", () => {
  const detail = addAuthorizationContextToDetail(
    {
      code: "management_permission_required",
      authorize_url:
        "https://www.botcord.chat/settings/agents/ag_test/cli-permissions?scopes=cloud_agents%3Acreate",
    },
    credentials,
  );

  const url = new URL(detail.authorize_url);
  assert.equal(url.searchParams.get("credential_key_id"), "k_test");
  assert.equal(url.searchParams.get("credential_name"), "Work laptop CLI");
  assert.equal(url.searchParams.get("credential_saved_at"), credentials.savedAt);
  assert.ok(url.searchParams.get("device_name"));
});

test("authorization context preserves existing query hints", () => {
  const url = addAuthorizationContextToUrl(
    "https://www.botcord.chat/settings/agents/ag_test/cli-permissions?scopes=x&device_name=Existing",
    credentials,
  );

  assert.equal(new URL(url).searchParams.get("device_name"), "Existing");
});

test("authorization context ignores unrelated errors", () => {
  const detail = { code: "other_error", authorize_url: "https://example.com" };
  assert.equal(addAuthorizationContextToDetail(detail, credentials), detail);
});
